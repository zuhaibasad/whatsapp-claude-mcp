// Lock election + role handling for one process.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createLogger } from '../core/logger.js';
import type { DataPaths } from '../core/paths.js';
import type { CollectorState, SetupScreen } from '../core/service.js';
import { createMasterKeyStore, napiKeyringBackend } from '../crypto/index.js';
import { DaemonAlreadyRunningError, acquireLock } from '../daemon/lock.js';
import { createWaClient } from '../daemon/wa/index.js';
import { createHostClient } from './client.js';
import { HolderCore } from './core.js';
import { migrateLegacyDataDir } from './migrate.js';
import { startControlServer, type ControlServer } from './server.js';
import { HOST_VERSION, type HostDeps, type HostHandle, type HostOps, type HostRole } from './types.js';

export function defaultOpenUrl(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

export function resolveHostDeps(paths: DataPaths, over: Partial<HostDeps> = {}): HostDeps {
  const keyring = over.keyring ?? napiKeyringBackend();
  return {
    keyring,
    keyStore: over.keyStore ?? ((root) => createMasterKeyStore(root, keyring)),
    waClientFactory: over.waClientFactory ?? ((a) => createWaClient({ auth: a.auth, logger: a.logger, onFrame: a.onFrame })),
    logger: over.logger ?? createLogger({ level: 'info', file: paths.logFile, name: 'wa-bridge-host' }),
    openUrl: over.openUrl ?? defaultOpenUrl,
    lockRetryMs: over.lockRetryMs ?? 30_000,
    liveQuietMs: over.liveQuietMs ?? 5_000,
    liveMaxMs: over.liveMaxMs ?? 60_000,
    chooseTimeoutMs: over.chooseTimeoutMs ?? 30 * 60_000,
    linkTimeoutMs: over.linkTimeoutMs ?? 5 * 60_000,
    settle: over.settle ?? {},
    disconnectTimeoutMs: over.disconnectTimeoutMs ?? 20_000,
    uiHtmlPath: over.uiHtmlPath ?? process.env['WA_BRIDGE_UI_HTML'] ?? null,
    version: over.version ?? HOST_VERSION,
    now: over.now ?? Date.now,
  };
}

/** Creates a host instance (no global state). Most callers use startHost. */
export function createHost(paths: DataPaths, over: Partial<HostDeps> = {}): HostHandle {
  const deps = resolveHostDeps(paths, over);
  migrateLegacyDataDir(paths, { keyring: deps.keyring, logger: deps.logger }); // T15: copy old %LOCALAPPDATA% data once
  const logger = deps.logger;
  const client = createHostClient(paths, { keyring: deps.keyring });
  let role: HostRole = 'follower';
  let stopped = false;
  let core: HolderCore | null = null;
  let server: ControlServer | null = null;
  let lock: { release(): void } | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let lastSeen: CollectorState = 'not_linked';
  let electing: Promise<void> = Promise.resolve();

  async function tryBecomeHolder(): Promise<void> {
    if (stopped || role === 'holder') return;
    fs.mkdirSync(paths.dataDir, { recursive: true });
    try {
      lock = acquireLock(paths.lockFile);
    } catch (err) {
      if (err instanceof DaemonAlreadyRunningError) return;
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'lock attempt failed');
      return;
    }
    try {
      const c = new HolderCore(paths, deps, logger);
      server = await startControlServer(c, paths, deps, logger, paths);
      core = c;
      role = 'holder';
      await c.start();
      logger.info({ port: server.port }, 'host is the holder');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'could not start as holder');
      await server?.close();
      server = null;
      core = null;
      lock.release();
      lock = null;
      role = 'follower';
    }
  }

  function scheduleRetry(): void {
    if (stopped || role === 'holder') return;
    retry = setTimeout(() => {
      retry = null;
      electing = tryBecomeHolder().finally(scheduleRetry);
    }, deps.lockRetryMs);
    retry.unref();
  }

  const ready = (electing = tryBecomeHolder()).finally(scheduleRetry);

  const wrap = <A extends unknown[], R>(f: (o: HostOps) => (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => f(core && role === 'holder' ? core : client)(...a);

  const ops: HostOps = {
    state: async () => {
      const s = await wrap((o) => () => o.state())();
      lastSeen = s.collector;
      return s;
    },
    acceptRisk: wrap((o) => (nonce?: string) => o.acceptRisk(nonce)),
    startLink: wrap((o) => () => o.startLink()),
    cancelLink: wrap((o) => () => o.cancelLink()),
    chatRows: wrap((o) => () => o.chatRows()),
    submitSelection: wrap((o) => (ids: string[] | null) => o.submitSelection(ids)),
    waitForSync: wrap((o) => (ms: number) => o.waitForSync(ms)),
    disconnect: wrap((o) => (opts: { keepData: boolean; nonce?: string }) => o.disconnect(opts)),
    diagnose: wrap((o) => () => o.diagnose()),
    mintNonce: wrap((o) => (kind?: 'accept' | 'disconnect') => o.mintNonce(kind)),
    openSetup: wrap((o) => (screen?: SetupScreen) => o.openSetup(screen)),
  };

  return {
    paths,
    ready,
    ops,
    role: () => (stopped ? 'stopped' : role),
    collectorState: () => (core && role === 'holder' ? core.collectorState() : lastSeen),
    async stop() {
      if (stopped) return;
      stopped = true;
      if (retry) clearTimeout(retry);
      await electing.catch(() => undefined);
      if (role === 'holder') {
        await core?.stop();
        await server?.close();
        lock?.release();
      }
      core = null;
      server = null;
      lock = null;
      role = 'follower';
    },
  };
}
