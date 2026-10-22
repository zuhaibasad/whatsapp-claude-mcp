// The daemon: lock, open DBs, connect to WhatsApp, ingest, reconnect with backoff, retention.
import fs from 'node:fs';
import type { Config, Db, MasterKeyStore, WaClient } from '../core/contracts.js';
import type { CollectorState } from '../core/service.js';
import { createLogger, type Logger } from '../core/logger.js';
import { resolvePaths, type DataPaths } from '../core/paths.js';
import { loadConfig } from '../config/index.js';
import { createMasterKeyStore, deriveDbKey, openEncryptedDb } from '../crypto/index.js';
import { SqliteStore } from '../store/index.js';
import { Backoff, shouldReconnect } from './backoff.js';
import { HEALTH_TICK_MS, HealthMonitor, type HealthClock } from './health.js';
import { Ingestor } from './ingest.js';
import { acquireLock } from './lock.js';
import { createWaClient, useDbAuthState, type DbAuthState } from './wa/index.js';

export interface WaClientFactoryArgs {
  auth: DbAuthState;
  logger: Logger;
  /** Factories should pass this to createWaClient({ onFrame }) so the collector can detect stalls. Optional. */
  onFrame?: () => void;
}

export interface RunnerDeps {
  keyStore: (projectRoot: string) => MasterKeyStore;
  waClientFactory: (args: WaClientFactoryArgs) => WaClient;
  logger: Logger;
  /** Install SIGINT/SIGTERM handlers that call stop(). Default true. */
  installSignalHandlers: boolean;
}

export interface DaemonHandle {
  stop(): Promise<void>;
  /** Resolves when the daemon has fully stopped (by stop() or by a fatal condition). */
  done: Promise<{ reason: string }>;
}

export interface OpenedDbs {
  store: SqliteStore;
  storeDb: Db;
  authDb: Db;
  auth: DbAuthState;
  close(): void;
}

export const NOT_INITIALIZED_MESSAGE = 'no encryption key found: run wa-bridge init';

/** Opens store.db and auth.db with keys derived from the master key. Shared by the daemon and linking. */
export async function openDaemonDbs(paths: DataPaths, master: Buffer): Promise<OpenedDbs> {
  const storeDb = openEncryptedDb(paths.storeDb, deriveDbKey(master, 'store'));
  let authDb: Db | null = null;
  try {
    const store = new SqliteStore(storeDb);
    store.migrate();
    authDb = openEncryptedDb(paths.authDb, deriveDbKey(master, 'auth'));
    const auth = await useDbAuthState(authDb);
    const a = authDb;
    return {
      store,
      storeDb,
      authDb: a,
      auth,
      close(): void {
        try { storeDb.close(); } catch { /* already closed */ }
        try { a.close(); } catch { /* already closed */ }
      },
    };
  } catch (err) {
    try { storeDb.close(); } catch { /* ignore */ }
    try { authDb?.close(); } catch { /* ignore */ }
    throw err;
  }
}

const HOUR_MS = 3_600_000;
const CONFIG_POLL_MS = 30_000;
const SYNC_THROTTLE_MS = 10_000;
const VACUUM_EVERY_S = 7 * 86_400;

function configMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export interface CollectorOptions {
  paths: DataPaths;
  /** Open databases. The caller owns them: stop() does not close them. */
  dbs: Pick<OpenedDbs, 'store' | 'storeDb' | 'auth'>;
  logger: Logger;
  waClientFactory: (args: WaClientFactoryArgs) => WaClient;
  /** After caught_up, the collector is live once no message arrived for this long. Default 5 s. */
  liveQuietMs?: number;
  /** The collector is live at the latest this long after open. Default 60 s. */
  liveMaxMs?: number;
  /** Called on every collector state change. */
  onState?(s: CollectorState): void;
  /** Test hooks for health monitoring. */
  healthClock?: HealthClock;
  healthTickMs?: number;
  keepAliveIntervalMs?: number;
}

export interface CollectorHandle {
  /** Closes the WhatsApp connection (no logout) and stops the timers. Does not close the DBs. Idempotent. */
  stop(): Promise<void>;
  /** Resolves when the collector has stopped (by stop() or by a fatal condition). */
  done: Promise<{ reason: string }>;
  state(): CollectorState;
  /** Subscribes to state changes; returns an unsubscribe function. */
  onState(listener: (s: CollectorState) => void): () => void;
}

/**
 * The embeddable collector: connects, ingests, reconnects with backoff, runs retention.
 * No lock, no signal handlers, no process.exit. Throws if the config is invalid.
 */
export function startCollector(opts: CollectorOptions): CollectorHandle {
  const { paths, logger, waClientFactory } = opts;
  const { store, storeDb, auth } = opts.dbs;
  const liveQuietMs = opts.liveQuietMs ?? 5_000;
  const liveMaxMs = opts.liveMaxMs ?? 60_000;
  let config: Config = loadConfig(paths).config;

  let stopped = false;
  let attemptActive = false;
  let restartUsed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSyncWrite = 0;
  let configMtimeSeen = configMtime(paths.config);
  let currentMe: { id: string; lid: string | null } | null = null;
  const backoff = new Backoff();
  let resolveDone: (v: { reason: string }) => void = () => undefined;
  const done = new Promise<{ reason: string }>((r) => { resolveDone = r; });
  const nowS = (): number => Math.floor(Date.now() / 1000);

  const guarded = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger.error({ what, err: err instanceof Error ? err.message : String(err) }, 'handler failed');
    }
  };

  // ---- collector state: connecting -> catching_up -> live ----
  let state: CollectorState = 'connecting';
  let caughtUp = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(s: CollectorState) => void>();
  if (opts.onState) listeners.add(opts.onState);
  const clearLiveTimers = (): void => {
    if (quietTimer) clearTimeout(quietTimer);
    if (maxTimer) clearTimeout(maxTimer);
    quietTimer = null;
    maxTimer = null;
  };
  const setState = (s: CollectorState): void => {
    if (state === s) return;
    state = s;
    if (s !== 'catching_up') clearLiveTimers();
    guarded('collector_state', () => {
      store.setMeta('collector_state', s);
      if (s === 'live') store.setMeta('last_live_at', String(nowS()));
    });
    for (const l of listeners) {
      try { l(s); } catch { /* a listener error never breaks ingest */ }
    }
  };
  const goLive = (): void => { if (state === 'catching_up' && !stopped) setState('live'); };
  const armQuiet = (): void => {
    if (state !== 'catching_up' || !caughtUp) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(goLive, liveQuietMs);
  };

  const acct = store.getAccount();
  if (acct) currentMe = { id: acct.id, lid: acct.lid };

  const ingestor = new Ingestor(
    store,
    () => config,
    () => (currentMe ? { ...currentMe, names: config.myNames } : null),
    logger,
  );
  ingestor.recomputeIncluded();

  const health = new HealthMonitor({
    writeMeta: (k, v) => store.setMeta(k, v),
    ...(opts.healthClock ? { clock: opts.healthClock } : {}),
    ...(opts.keepAliveIntervalMs ? { keepAliveIntervalMs: opts.keepAliveIntervalMs } : {}),
  });
  let socketOpen = false;
  let forcing = false;
  const client = waClientFactory({ auth, logger, onFrame: () => health.frame() });

  const touchSync = (): void => {
    health.appEvent();
    armQuiet();
    const t = Date.now();
    if (t - lastSyncWrite < SYNC_THROTTLE_MS) return;
    lastSyncWrite = t;
    guarded('last_sync_at', () => store.setMeta('last_sync_at', String(nowS())));
  };

  const runRetention = (): void => {
    guarded('retention', () => {
      const now = nowS();
      const deleted = store.purgeOlderThan(now - config.retentionDays * 86_400);
      store.setMeta('last_purge_at', String(now));
      const lastVacuum = Number(store.getMeta('last_vacuum_at') ?? 0);
      if (!Number.isFinite(lastVacuum) || now - lastVacuum > VACUUM_EVERY_S) {
        storeDb.exec('VACUUM');
        store.setMeta('last_vacuum_at', String(now));
      }
      logger.info({ deleted }, 'retention purge done');
    });
  };

  const checkConfig = (): void => {
    guarded('config', () => {
      const m = configMtime(paths.config);
      if (m === configMtimeSeen) return;
      configMtimeSeen = m;
      try {
        config = loadConfig(paths).config;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'config reload failed, keeping previous');
        return;
      }
      ingestor.recomputeIncluded();
    });
  };

  const clearReconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const connect = (): void => {
    if (stopped || attemptActive) return;
    attemptActive = true;
    client.connect().catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'connect failed');
      attemptActive = false;
      scheduleReconnect();
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped || attemptActive || reconnectTimer) return;
    const delay = backoff.next();
    logger.info({ delayMs: delay, attempt: backoff.attempts }, 'reconnect scheduled');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  // Closes the socket without logout and reconnects: at once (sleep/resume) or via backoff (stall).
  const forceReconnect = async (reason: string, immediate: boolean): Promise<void> => {
    if (stopped || forcing) return;
    forcing = true;
    try {
      logger.warn({ reason }, 'forcing reconnect');
      health.reconnect(reason);
      health.disconnected();
      socketOpen = false;
      clearReconnect();
      caughtUp = false;
      setState('reconnecting');
      try {
        await client.close();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'client close failed');
      }
      attemptActive = false;
      if (stopped) return;
      if (immediate) connect();
      else scheduleReconnect();
    } finally {
      forcing = false;
    }
  };

  const healthTick = (): void => {
    if (stopped || forcing) return;
    const action = health.tick();
    if (action === 'sleep') {
      // A socket that is mid-connect is left alone; Baileys' connect timeout handles it.
      if (attemptActive && !socketOpen) return;
      void forceReconnect('sleep_resume', true);
    } else if (action === 'stall') {
      void forceReconnect('app_stall', false);
    }
  };

  const fatal = (reason: string, end: CollectorState): void => {
    void stop(reason, end);
  };

  client.on('connection', (s) => {
    if (stopped) return;
    touchSync();
    switch (s.state) {
      case 'connecting':
        if (state !== 'reconnecting') setState('connecting');
        return;
      case 'caught_up':
        caughtUp = true;
        armQuiet();
        return;
      case 'qr':
        // Session expired: the daemon never shows a QR. Linking is the CLI's job.
        attemptActive = false;
        guarded('status', () => store.setLinkStatus('logged_out'));
        logger.error('session no longer valid (QR requested): run wa-bridge link');
        fatal('qr_requested', 'logged_out');
        return;
      case 'open':
        attemptActive = false;
        restartUsed = false;
        backoff.reset();
        socketOpen = true;
        health.connected();
        currentMe = { id: s.me.id, lid: s.me.lid };
        guarded('account', () => store.upsertAccount({
          id: s.me.id,
          lid: s.me.lid,
          pushName: s.me.pushName,
          linkStatus: 'linked',
          lastConnectedAt: nowS(),
        }));
        logger.info('connected');
        caughtUp = false;
        setState('catching_up');
        clearLiveTimers();
        maxTimer = setTimeout(goLive, liveMaxMs);
        return;
      case 'close': {
        attemptActive = false;
        socketOpen = false;
        health.disconnected();
        if (s.retry) health.reconnect(s.reason);
        guarded('status', () => store.setLinkStatus('disconnected'));
        logger.warn({ reason: s.reason, retry: s.retry }, 'connection closed');
        if (s.retry || s.reason === 'restart_required') setState('reconnecting');
        if (s.reason === 'restart_required') {
          if (!restartUsed) {
            restartUsed = true;
            connect();
          } else {
            scheduleReconnect();
          }
          return;
        }
        if (shouldReconnect(s)) {
          scheduleReconnect();
          return;
        }
        if (s.reason === 'logged_out') {
          guarded('status', () => store.setLinkStatus('logged_out'));
          guarded('auth', () => auth.clear());
          logger.error('logged out by WhatsApp: run wa-bridge link');
        } else {
          logger.error({ reason: s.reason }, 'connection closed permanently, stopping');
        }
        fatal(s.reason, s.reason === 'logged_out' ? 'logged_out' : 'stopped');
      }
    }
  });
  client.on('messages', (m) => { touchSync(); guarded('messages', () => ingestor.onMessages(m)); });
  client.on('edit', (e) => { touchSync(); guarded('edit', () => ingestor.onEdit(e)); });
  client.on('delete', (e) => { touchSync(); guarded('delete', () => ingestor.onDelete(e)); });
  client.on('chats', (c) => { touchSync(); guarded('chats', () => ingestor.onChats(c)); });
  client.on('groups', (g) => { touchSync(); guarded('groups', () => ingestor.onGroups(g)); });
  client.on('contacts', (c) => { touchSync(); guarded('contacts', () => ingestor.onContacts(c)); });
  client.on('lid-map', (m) => { health.appEvent(); guarded('lid-map', () => ingestor.onLidMap(m)); });
  client.on('activity', (a) => { health.appEvent(); guarded('activity', () => ingestor.onActivity(a)); });

  const healthTimer = setInterval(healthTick, opts.healthTickMs ?? HEALTH_TICK_MS);
  runRetention();
  const retentionTimer = setInterval(runRetention, HOUR_MS);
  const configTimer = setInterval(checkConfig, CONFIG_POLL_MS);

  let stopPromise: Promise<void> | null = null;
  function stop(reason = 'stop', end: CollectorState = 'stopped'): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      clearReconnect();
      clearInterval(retentionTimer);
      clearInterval(configTimer);
      clearInterval(healthTimer);
      health.flush(true);
      clearLiveTimers();
      try {
        await client.close();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'client close failed');
      }
      setState(end);
      resolveDone({ reason });
    })();
    return stopPromise;
  }

  connect();
  return {
    stop: () => stop('stop'),
    done,
    state: () => state,
    onState(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export async function runDaemon(opts: { projectRoot: string; deps?: Partial<RunnerDeps> }): Promise<DaemonHandle> {
  const paths = resolvePaths(opts.projectRoot);
  const keyStore = (opts.deps?.keyStore ?? createMasterKeyStore)(paths.projectRoot);
  const waClientFactory = opts.deps?.waClientFactory ?? ((a: WaClientFactoryArgs) => createWaClient({ auth: a.auth, logger: a.logger, ...(a.onFrame ? { onFrame: a.onFrame } : {}) }));

  fs.mkdirSync(paths.dataDir, { recursive: true });
  const lock = acquireLock(paths.lockFile);
  let dbs: OpenedDbs | null = null;
  let logger!: Logger;
  let collector!: CollectorHandle;
  try {
    const master = keyStore.get();
    if (!master) throw new Error(NOT_INITIALIZED_MESSAGE);
    const config = loadConfig(paths).config;
    logger = opts.deps?.logger ?? createLogger({ level: config.logLevel, file: paths.logFile, name: 'wa-bridge-daemon' });
    dbs = await openDaemonDbs(paths, master);
    if (!dbs.auth.hasCreds()) throw new Error('not linked: run wa-bridge link');
    collector = startCollector({ paths, dbs, logger, waClientFactory });
  } catch (err) {
    dbs?.close();
    lock.release();
    throw err;
  }
  const opened = dbs;

  const signalHandler = (): void => { void collector.stop(); };
  const installSignals = opts.deps?.installSignalHandlers ?? true;
  if (installSignals) {
    process.once('SIGINT', signalHandler);
    process.once('SIGTERM', signalHandler);
  }
  const done = collector.done.then((r) => {
    if (installSignals) {
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
    }
    opened.close();
    lock.release();
    logger.info({ reason: r.reason }, 'daemon stopped');
    return r;
  });
  return {
    stop: async () => {
      await collector.stop();
      await done;
    },
    done,
  };
}
