// Linking: shows QR codes via a callback until the user scans, then records the account.
import fs from 'node:fs';
import type { MasterKeyStore, WaClient } from '../core/contracts.js';
import { createLogger, type Logger } from '../core/logger.js';
import { resolvePaths } from '../core/paths.js';
import { createMasterKeyStore } from '../crypto/index.js';
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

export async function linkAccount(opts: {
  projectRoot: string;
  onQr(qr: string): Promise<void> | void;
  timeoutMs?: number;
  deps?: Partial<LinkDeps>;
}): Promise<{ id: string; pushName: string | null }> {
  const paths = resolvePaths(opts.projectRoot);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const keyStore = (opts.deps?.keyStore ?? createMasterKeyStore)(paths.projectRoot);
  const waClientFactory =
    opts.deps?.waClientFactory ?? ((a: WaClientFactoryArgs) => createWaClient({ auth: a.auth, logger: a.logger }));

  fs.mkdirSync(paths.dataDir, { recursive: true });
  let lock: { release(): void } | null = null;
  let dbs: OpenedDbs | null = null;
  let client: WaClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
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
    const logger = opts.deps?.logger ?? createLogger({ level: 'warn', name: 'wa-bridge-link' });
    dbs = await openDaemonDbs(paths, master);
    const { store, auth } = dbs;

    const existing = store.getAccount();
    if (auth.hasCreds() && existing && existing.linkStatus !== 'logged_out' && existing.linkStatus !== 'unlinked') {
      throw new AlreadyLinkedError();
    }

    const c = waClientFactory({ auth, logger });
    client = c;
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
            settled = true;
            resolve({ id: s.me.id, pushName: s.me.pushName });
            return;
          }
          case 'close':
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
