// The daemon: lock, open DBs, connect to WhatsApp, ingest, reconnect with backoff, retention.
import fs from 'node:fs';
import type { Config, Db, MasterKeyStore, WaClient } from '../core/contracts.js';
import { createLogger, type Logger } from '../core/logger.js';
import { resolvePaths, type DataPaths } from '../core/paths.js';
import { loadConfig } from '../config/index.js';
import { createMasterKeyStore, deriveDbKey, openEncryptedDb } from '../crypto/index.js';
import { SqliteStore } from '../store/index.js';
import { Backoff, shouldReconnect } from './backoff.js';
import { Ingestor } from './ingest.js';
import { acquireLock } from './lock.js';
import { createWaClient, useDbAuthState, type DbAuthState } from './wa/index.js';

export interface WaClientFactoryArgs {
  auth: DbAuthState;
  logger: Logger;
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

export async function runDaemon(opts: { projectRoot: string; deps?: Partial<RunnerDeps> }): Promise<DaemonHandle> {
  const paths = resolvePaths(opts.projectRoot);
  const keyStore = (opts.deps?.keyStore ?? createMasterKeyStore)(paths.projectRoot);
  const waClientFactory = opts.deps?.waClientFactory ?? ((a: WaClientFactoryArgs) => createWaClient({ auth: a.auth, logger: a.logger }));

  fs.mkdirSync(paths.dataDir, { recursive: true });
  const lock = acquireLock(paths.lockFile);
  let dbs: OpenedDbs | null = null;
  let config!: Config;
  let logger!: Logger;
  try {
    const master = keyStore.get();
    if (!master) throw new Error(NOT_INITIALIZED_MESSAGE);
    config = loadConfig(paths).config;
    logger = opts.deps?.logger ?? createLogger({ level: config.logLevel, file: paths.logFile, name: 'wa-bridge-daemon' });
    dbs = await openDaemonDbs(paths, master);
    if (!dbs.auth.hasCreds()) throw new Error('not linked: run wa-bridge link');
  } catch (err) {
    dbs?.close();
    lock.release();
    throw err;
  }
  const opened = dbs;
  const { store, storeDb, auth } = opened;

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

  const acct = store.getAccount();
  if (acct) currentMe = { id: acct.id, lid: acct.lid };

  const ingestor = new Ingestor(
    store,
    () => config,
    () => (currentMe ? { ...currentMe, names: config.myNames } : null),
    logger,
  );
  ingestor.recomputeIncluded();

  const client = waClientFactory({ auth, logger });
  const nowS = (): number => Math.floor(Date.now() / 1000);

  const guarded = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger.error({ what, err: err instanceof Error ? err.message : String(err) }, 'handler failed');
    }
  };

  const touchSync = (): void => {
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

  const signalHandler = (): void => { void stop('signal'); };
  const installSignals = opts.deps?.installSignalHandlers ?? true;
  if (installSignals) {
    process.once('SIGINT', signalHandler);
    process.once('SIGTERM', signalHandler);
  }

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

  const fatal = (reason: string): void => {
    void stop(reason);
  };

  client.on('connection', (s) => {
    if (stopped) return;
    touchSync();
    switch (s.state) {
      case 'connecting':
        return;
      case 'qr':
        // Session expired: the daemon never shows a QR. Linking is the CLI's job.
        attemptActive = false;
        guarded('status', () => store.setLinkStatus('logged_out'));
        logger.error('session no longer valid (QR requested): run wa-bridge link');
        fatal('qr_requested');
        return;
      case 'open':
        attemptActive = false;
        restartUsed = false;
        backoff.reset();
        currentMe = { id: s.me.id, lid: s.me.lid };
        guarded('account', () => store.upsertAccount({
          id: s.me.id,
          lid: s.me.lid,
          pushName: s.me.pushName,
          linkStatus: 'linked',
          lastConnectedAt: nowS(),
        }));
        logger.info('connected');
        return;
      case 'close': {
        attemptActive = false;
        guarded('status', () => store.setLinkStatus('disconnected'));
        logger.warn({ reason: s.reason, retry: s.retry }, 'connection closed');
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
        fatal(s.reason);
      }
    }
  });
  client.on('messages', (m) => { touchSync(); guarded('messages', () => ingestor.onMessages(m)); });
  client.on('edit', (e) => { touchSync(); guarded('edit', () => ingestor.onEdit(e)); });
  client.on('delete', (e) => { touchSync(); guarded('delete', () => ingestor.onDelete(e)); });
  client.on('chats', (c) => { touchSync(); guarded('chats', () => ingestor.onChats(c)); });
  client.on('groups', (g) => { touchSync(); guarded('groups', () => ingestor.onGroups(g)); });
  client.on('contacts', (c) => { touchSync(); guarded('contacts', () => ingestor.onContacts(c)); });

  runRetention();
  const retentionTimer = setInterval(runRetention, HOUR_MS);
  const configTimer = setInterval(checkConfig, CONFIG_POLL_MS);

  let stopPromise: Promise<void> | null = null;
  function stop(reason = 'stop'): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      clearReconnect();
      clearInterval(retentionTimer);
      clearInterval(configTimer);
      if (installSignals) {
        process.removeListener('SIGINT', signalHandler);
        process.removeListener('SIGTERM', signalHandler);
      }
      try {
        await client.close();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'client close failed');
      }
      opened.close();
      lock.release();
      logger.info({ reason }, 'daemon stopped');
      resolveDone({ reason });
    })();
    return stopPromise;
  }

  connect();
  return { stop: () => stop('stop'), done };
}
