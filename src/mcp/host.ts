// Bridge between the MCP server and the collector host (src/host, built separately, T12).
// The MCP layer only sees this small interface; main.ts loads the real host lazily so the server can answer
// the MCP handshake before (and even without) the host.
import type { DataPaths } from '../core/paths.js';
import type { SetupOps, SetupState } from '../core/service.js';

export interface HostBridge {
  /** Setup operations: in-process if this process holds the lock, otherwise forwarded over HTTP. */
  ops(): SetupOps;
  /** Mints a single-use panel nonce (control-token level call). Never returned to the model. */
  mintNonce(): Promise<string>;
  /** Asks the lock holder to open the setup page in the default browser. Returns no URL. */
  openSetup(): Promise<void>;
  /** acceptRisk with the panel nonce that was embedded in the setup HTML. */
  acceptRisk(nonce: string): Promise<SetupState>;
  stop(): Promise<void>;
}

/** Shape of src/host/index.ts (T12): HostOps = SetupOps with nonce-aware acceptRisk, mintNonce and openSetup. */
interface HostOps extends SetupOps {
  acceptRisk(nonce?: string): Promise<SetupState>;
  mintNonce(): Promise<{ nonce: string }>;
  openSetup(): Promise<{ opened: true }>;
}
interface HostModule {
  startHost(paths: DataPaths): unknown;
  stopHost(): Promise<void> | void;
  getSetupOps(paths: DataPaths): HostOps;
}

/** Starts the real host in the background. Resolves once the module is loaded; startHost itself is not awaited. */
export async function loadRealHost(paths: DataPaths, onError: (e: unknown) => void): Promise<HostBridge> {
  // src/host is built by T12 in parallel. TODO(orchestrator): once it is merged, delete the next two comment lines.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore module may not exist in a partial checkout
  const mod = (await import('../host/index.js')) as HostModule;
  void Promise.resolve()
    .then(() => mod.startHost(paths))
    .catch(onError);
  return {
    ops: () => mod.getSetupOps(paths),
    mintNonce: async () => (await mod.getSetupOps(paths).mintNonce()).nonce,
    openSetup: async () => {
      await mod.getSetupOps(paths).openSetup();
    },
    acceptRisk: (nonce) => mod.getSetupOps(paths).acceptRisk(nonce),
    stop: async () => {
      await mod.stopHost();
    },
  };
}
