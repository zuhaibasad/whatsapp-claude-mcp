// Bridge between the MCP server and the collector host (src/host, built separately, T12).
// The MCP layer only sees this small interface; main.ts loads the real host lazily so the server can answer
// the MCP handshake before (and even without) the host.
import type { DataPaths } from '../core/paths.js';
import type { SetupOps, SetupScreen, SetupState } from '../core/service.js';

export interface HostBridge {
  /** Setup operations: in-process if this process holds the lock, otherwise forwarded over HTTP. */
  ops(): SetupOps;
  /** Mints a single-use panel nonce (control-token level call). Never returned to the model. */
  mintNonce(kind?: 'accept' | 'disconnect'): Promise<string>;
  /** Asks the lock holder to open the setup page in the default browser. Returns no URL. */
  openSetup(screen?: SetupScreen): Promise<void>;
  /** Disconnects WhatsApp with the panel's single-use disconnect nonce (never callable without one). */
  disconnect(nonce: string, keepData: boolean): Promise<SetupState>;
  /** acceptRisk with the panel nonce that was embedded in the setup HTML. */
  acceptRisk(nonce: string): Promise<SetupState>;
  stop(): Promise<void>;
}

/** Shape of src/host/index.ts (T12): HostOps = SetupOps with nonce-aware acceptRisk, mintNonce and openSetup. */
interface HostOps extends SetupOps {
  acceptRisk(nonce?: string): Promise<SetupState>;
  mintNonce(kind?: 'accept' | 'disconnect'): Promise<{ nonce: string }>;
  openSetup(screen?: SetupScreen): Promise<{ opened: true }>;
  disconnect(opts: { keepData: boolean; nonce?: string }): Promise<SetupState>;
}
interface HostModule {
  startHost(paths: DataPaths): unknown;
  stopHost(): Promise<void> | void;
  getSetupOps(paths: DataPaths): HostOps;
}

/** Starts the real host in the background. Resolves once the module is loaded; startHost itself is not awaited. */
export async function loadRealHost(paths: DataPaths, onError: (e: unknown) => void): Promise<HostBridge> {
  const mod: HostModule = await import('../host/index.js');
  void Promise.resolve()
    .then(() => mod.startHost(paths))
    .catch(onError);
  return {
    ops: () => mod.getSetupOps(paths),
    mintNonce: async (kind) => (await mod.getSetupOps(paths).mintNonce(kind)).nonce,
    openSetup: async (screen) => {
      await mod.getSetupOps(paths).openSetup(screen);
    },
    acceptRisk: (nonce) => mod.getSetupOps(paths).acceptRisk(nonce),
    disconnect: (nonce, keepData) => mod.getSetupOps(paths).disconnect({ keepData, nonce }),
    stop: async () => {
      await mod.stopHost();
    },
  };
}
