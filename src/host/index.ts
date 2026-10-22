// Collector host: runs inside the MCP server process. See docs/notes/T12.md.
import type { DataPaths } from '../core/paths.js';
import { createHostClient } from './client.js';
import { createHost } from './host.js';
import type { HostDeps, HostHandle, HostOps } from './types.js';

export { createHostClient, readHostInfo } from './client.js';
export { createHost } from './host.js';
export { initDataFiles, isInitialised } from './init.js';
export { HOST_VERSION, HostError, HostUnavailableError } from './types.js';
export type { HostDeps, HostHandle, HostOps, HostRole } from './types.js';

let current: HostHandle | null = null;

/**
 * Starts the host for this process: lock election, then holder (control server + collector) or follower.
 * Resolves after the first election attempt. Calling it again for the same data dir returns the same handle.
 */
export async function startHost(paths: DataPaths, deps: Partial<HostDeps> = {}): Promise<HostHandle> {
  if (current && current.paths.dataDir === paths.dataDir && current.role() !== 'stopped') return current;
  current = createHost(paths, deps);
  await current.ready;
  return current;
}

/** Stops the host started by startHost: closes the collector (no logout), the server and DBs, releases the lock. */
export async function stopHost(): Promise<void> {
  const h = current;
  current = null;
  if (h) await h.stop();
}

/** In-process ops when this process runs a host (it delegates to the holder over HTTP while a follower), else an HTTP client. */
export function getSetupOps(paths: DataPaths): HostOps {
  if (current && current.paths.dataDir === paths.dataDir && current.role() !== 'stopped') return current.ops;
  return createHostClient(paths);
}
