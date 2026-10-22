import type { DataPaths } from '../core/paths.js';
import type { KeyringBackend, MasterKeyStore, WaClient } from '../core/contracts.js';
import type { Logger } from '../core/logger.js';
import type { CollectorState, SetupOps } from '../core/service.js';
import type { SettleOptions } from '../daemon/link.js';
import type { WaClientFactoryArgs } from '../daemon/runner.js';

export const HOST_VERSION = '0.1.0';

/** SetupOps plus the host-only operations. Every method works in-process (holder) or over HTTP (follower). */
export interface HostOps extends SetupOps {
  /**
   * Records risk acceptance. Needs a valid panel nonce (from mintNonce) because only a user action may accept.
   * Over HTTP from a browser session the nonce is not needed.
   */
  acceptRisk(nonce?: string): ReturnType<SetupOps['acceptRisk']>;
  /** Mints a single-use panel nonce (10 minute TTL) to embed in the Desktop setup panel. */
  mintNonce(): Promise<{ nonce: string }>;
  /** Opens the default browser at the setup page (the one-time URL is never returned). */
  openSetup(screen?: 'auto' | 'chats'): Promise<{ opened: true }>;
}

export type HostRole = 'holder' | 'follower' | 'stopped';

export interface HostHandle {
  readonly paths: DataPaths;
  role(): HostRole;
  /** Delegates to the in-process holder, or to the holder over HTTP while this process is a follower. */
  readonly ops: HostOps;
  /** Collector state as seen by this process (holder: live value; follower: meta.collector_state from the store, else 'not_linked'). */
  collectorState(): CollectorState;
  /** Resolves once this host knows its role (the first lock attempt is done). */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export interface HostDeps {
  /** OS keychain backend (master key + control token). Default: the real keychain. */
  keyring: KeyringBackend;
  keyStore: (projectRoot: string) => MasterKeyStore;
  waClientFactory: (args: WaClientFactoryArgs) => WaClient;
  logger: Logger;
  /** Opens a URL in the default browser. Default: explorer.exe / open / xdg-open. */
  openUrl: (url: string) => void;
  /** Follower retry interval for the lock. Default 30 s. */
  lockRetryMs: number;
  liveQuietMs: number;
  liveMaxMs: number;
  /** How long to wait for the user's chat selection before keeping the defaults. Default 30 min. */
  chooseTimeoutMs: number;
  /** How long a QR session may wait for a scan. Default 5 min. */
  linkTimeoutMs: number;
  settle: Partial<SettleOptions>;
  /** Setup UI HTML file. Default: dist/ui/setup.html next to the build. */
  uiHtmlPath: string | null;
  version: string;
  now: () => number;
}

/** An error with an HTTP status, safe to show to the caller. */
export class HostError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HostError';
  }
}

/** The holder cannot be reached (no service.json, no token, connection refused). */
export class HostUnavailableError extends Error {
  constructor(message = 'the wa-bridge collector is not reachable') {
    super(message);
    this.name = 'HostUnavailableError';
  }
}

export const NONCE_TTL_MS = 10 * 60_000;
export const BROWSER_TOKEN_TTL_MS = 5 * 60_000;
