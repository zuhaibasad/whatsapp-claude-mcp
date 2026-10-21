import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import type { MasterKeyStore, WaClient } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import { createMasterKeyStore } from '../crypto/index.js';
import { createWaClient } from '../daemon/wa/index.js';
import type { DbAuthState } from '../daemon/wa/index.js';

// Local mirror of the T7 spec (docs/tasks/T7-daemon-runner.md). The real module is loaded lazily.
export interface LinkOptions {
  projectRoot: string;
  onQr(qr: string): Promise<void> | void;
  timeoutMs?: number;
}
export interface DaemonHandle {
  stop(): Promise<void>;
  /** Resolves when the daemon has ended by itself or via stop(). Optional so fakes can omit it. */
  done?: Promise<{ reason: string }>;
}
export interface DaemonModule {
  runDaemon(opts: { projectRoot: string }): Promise<DaemonHandle>;
  linkAccount(opts: LinkOptions): Promise<{ id: string; pushName: string | null }>;
  AlreadyLinkedError: new (...args: never[]) => Error;
}

export interface CliDeps {
  keyStore(projectRoot: string): MasterKeyStore;
  /** Milliseconds since epoch. */
  now(): number;
  linkAccount(opts: LinkOptions): Promise<{ id: string; pushName: string | null }>;
  isAlreadyLinkedError(e: unknown): boolean;
  runDaemon(opts: { projectRoot: string }): Promise<DaemonHandle>;
  /** Resolves when the foreground daemon should shut down (SIGINT/SIGTERM). */
  waitForShutdown(): Promise<void>;
  /** Starts `wa-bridge <args>` as a detached background process; returns its pid. */
  spawnDetached(args: string[]): number | undefined;
  /** Sends SIGTERM to a pid. */
  killPid(pid: number): void;
  sleep(ms: number): Promise<void>;
  createClient(auth: DbAuthState): WaClient;
  renderQr(qr: string): Promise<string>;
  writeQrPng(file: string, qr: string): Promise<void>;
  /** How long unlink waits for the socket to open. */
  unlinkOpenTimeoutMs: number;
}

// Literal specifier (the guard forbids non-literal import()). The file is added by T7; until it is merged
// tsc cannot resolve it, hence @ts-ignore (not @ts-expect-error, which would fail once it exists).
let cached: Promise<DaemonModule> | undefined;
function daemonModule(): Promise<DaemonModule> {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore module created by T7
  cached ??= import('../daemon/index.js') as Promise<DaemonModule>;
  return cached;
}

export function defaultDeps(): CliDeps {
  return {
    keyStore: (root) => createMasterKeyStore(root),
    now: () => Date.now(),
    linkAccount: async (o) => (await daemonModule()).linkAccount(o),
    isAlreadyLinkedError: (e) => e instanceof Error && e.name === 'AlreadyLinkedError',
    runDaemon: async (o) => (await daemonModule()).runDaemon(o),
    waitForShutdown: () =>
      new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      }),
    spawnDetached: (args) => {
      const script = process.argv[1] ?? '';
      const child = spawn(process.execPath, [script, ...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return child.pid;
    },
    killPid: (pid) => void process.kill(pid, 'SIGTERM'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    createClient: (auth) => createWaClient({ auth, logger: createLogger({ level: 'warn', name: 'wa-bridge-unlink' }) }),
    renderQr: (qr) => QRCode.toString(qr, { type: 'terminal', small: true }),
    writeQrPng: (file, qr) => QRCode.toFile(file, qr),
    unlinkOpenTimeoutMs: 30_000,
  };
}
