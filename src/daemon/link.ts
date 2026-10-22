// Linking: shows QR codes via a callback until the user scans, then records the account.
import fs from 'node:fs';
import { loadConfig } from '../config/index.js';
import type { MasterKeyStore, WaClient } from '../core/contracts.js';
import { createLogger, type Logger } from '../core/logger.js';
import { resolvePaths } from '../core/paths.js';
import { createMasterKeyStore } from '../crypto/index.js';
import { Ingestor } from './ingest.js';
import { DaemonAlreadyRunningError, acquireLock } from './lock.js';
import { NOT_INITIALIZED_MESSAGE, openDaemonDbs, type OpenedDbs, type WaClientFactoryArgs } from './runner.js';
import { createWaClient } from './wa/index.js';

export class AlreadyLinkedError extends Error {
  constructor() {
    super('already linked: run wa-bridge unlink first');
    this.name = 'AlreadyLinkedError';
  }
}

export interface LinkDeps {
  keyStore: (projectRoot: string) => MasterKeyStore;
  waClientFactory: (args: WaClientFactoryArgs) => WaClient;
  logger: Logger;
}

const MAX_RESTARTS = 3;

/**
 * After the first open, stay connected while WhatsApp delivers the initial sync to the new device,
 * store it, and close once events go quiet. Closing right at open dropped that sync and cut off
 * Baileys' startup queries mid-flight.
 */
export interface SettleOptions {
  minMs: number;   // stay at least this long after open
  quietMs: number; // then close after this long without events
  maxMs: number;   // hard cap after open
}
export const DEFAULT_SETTLE: SettleOptions = { minMs: 10_000, quietMs: 15_000, maxMs: 120_000 };

export async function linkAccount(opts: {
  projectRoot: string;
  onQr(qr: string): Promise<void> | void;
  timeoutMs?: number;
  /** Progress lines for the user (e.g. "receiving initial sync"). */
  onStatus?(msg: string): void;
  settle?: Partial<SettleOptions>;
  deps?: Partial<LinkDeps>;
}): Promise<{ id: string; pushName: string | null }> {
  const paths = resolvePaths(opts.projectRoot);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const settle: SettleOptions = { ...DEFAULT_SETTLE, ...opts.settle };
  const keyStore = (opts.deps?.keyStore ?? createMasterKeyStore)(paths.projectRoot);
  const waClientFactory =
    opts.deps?.waClientFactory ?? ((a: WaClientFactoryArgs) => createWaClient({ auth: a.auth, logger: a.logger }));

  fs.mkdirSync(paths.dataDir, { recursive: true });
  let lock: { release(): void } | null = null;
  let dbs: OpenedDbs | null = null;
  let client: WaClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setInterval> | null = null;
  try {
    try {
      lock = acquireLock(paths.lockFile);
    } catch (err) {
      if (err instanceof DaemonAlreadyRunningError) {
        throw new Error(`the daemon is running (pid ${err.pid}): stop the daemon first`);
      }
      throw err;
    }
    const master = keyStore.get();
    if (!master) throw new Error(NOT_INITIALIZED_MESSAGE);
    const logger = opts.deps?.logger ?? createLogger({ level: 'warn', name: 'wa-bridge-link', file: paths.logFile });
    dbs = await openDaemonDbs(paths, master);
    const { store, auth } = dbs;

    const existing = store.getAccount();
    if (auth.hasCreds() && existing && existing.linkStatus !== 'logged_out' && existing.linkStatus !== 'unlinked') {
      throw new AlreadyLinkedError();
    }

    let config = loadConfig(paths).config;
    let me: { id: string; lid: string | null } | null = null;
    const ingestor = new Ingestor(store, () => config, () => (me ? { ...me, names: config.myNames } : null), logger);
    let lastEventAt = Date.now();
    const guarded = (what: string, fn: () => void): void => {
      lastEventAt = Date.now();
      try {
        fn();
      } catch (err) {
        logger.warn({ what, err: err instanceof Error ? err.message : String(err) }, 'ingest during link failed');
      }
    };

    const c = waClientFactory({ auth, logger });
    client = c;
    c.on('messages', (m) => guarded('messages', () => ingestor.onMessages(m)));
    c.on('edit', (e) => guarded('edit', () => ingestor.onEdit(e)));
    c.on('delete', (e) => guarded('delete', () => ingestor.onDelete(e)));
    c.on('chats', (x) => guarded('chats', () => ingestor.onChats(x)));
    c.on('groups', (g) => guarded('groups', () => ingestor.onGroups(g)));
    c.on('contacts', (x) => guarded('contacts', () => ingestor.onContacts(x)));
    return await new Promise<{ id: string; pushName: string | null }>((resolve, reject) => {
      let settled = false;
      let restarts = 0;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      timer = setTimeout(() => fail(new Error('linking timed out: no QR scan within the time limit')), timeoutMs);

      const connect = (): void => {
        c.connect().catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
      };

      c.on('connection', (s) => {
        if (settled) return;
        switch (s.state) {
          case 'qr':
            void Promise.resolve()
              .then(() => opts.onQr(s.qr))
              .catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
            return;
          case 'open': {
            if (me) return; // a later re-open while settling
            try {
              const nowS = Math.floor(Date.now() / 1000);
              store.upsertAccount({
                id: s.me.id,
                lid: s.me.lid,
                pushName: s.me.pushName,
                linkStatus: 'linked',
                linkedAt: nowS,
                lastConnectedAt: nowS,
              });
            } catch (err) {
              fail(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            me = { id: s.me.id, lid: s.me.lid };
            config = loadConfig(paths).config;
            if (timer) clearTimeout(timer);
            opts.onStatus?.('Linked. Receiving the initial sync from your phone (up to 2 minutes)...');
            const openAt = Date.now();
            lastEventAt = openAt;
            const result = { id: s.me.id, pushName: s.me.pushName };
            settleTimer = setInterval(() => {
              const now = Date.now();
              const quiet = now - openAt >= settle.minMs && now - lastEventAt >= settle.quietMs;
              if (quiet || now - openAt >= settle.maxMs) {
                if (settleTimer) clearInterval(settleTimer);
                settled = true;
                try {
                  store.setMeta('last_sync_at', String(Math.floor(lastEventAt / 1000)));
                } catch {
                  // best effort
                }
                resolve(result);
              }
            }, Math.max(10, Math.min(1000, settle.quietMs || 10)));
            return;
          }
          case 'close':
            if (me) {
              // Already linked; the connection dropped while settling. Keep what we have.
              if (settleTimer) clearInterval(settleTimer);
              settled = true;
              resolve({ id: me.id, pushName: store.getAccount()?.pushName ?? null });
              return;
            }
            if (s.reason === 'restart_required') {
              // Normal right after scanning: the pairing flow needs a fresh connection.
              if (++restarts > MAX_RESTARTS) fail(new Error('linking failed: too many restarts'));
              else connect();
              return;
            }
            if (s.reason === 'logged_out') {
              try {
                auth.clear();
              } catch {
                // best effort
              }
              fail(new Error('linking failed: WhatsApp rejected the session (logged out)'));
              return;
            }
            fail(new Error(`linking failed: connection closed (${s.reason})`));
            return;
          default:
            return;
        }
      });
      connect();
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (settleTimer) clearInterval(settleTimer);
    try {
      await client?.close();
    } catch {
      // ignore
    }
    dbs?.close();
    lock?.release();
    fs.rmSync(paths.qrPng, { force: true });
  }
}
