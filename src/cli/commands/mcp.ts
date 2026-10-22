import type { CliDeps } from '../deps.js';
import type { Io } from '../io.js';
import { requireInitialised } from '../open.js';
import { resolvePaths } from '../../core/paths.js';

/** Runs the MCP server on stdio. stdout belongs to the protocol, so this prints nothing itself. */
export async function mcpCommand(opts: { project: string }, _io: Io, deps: CliDeps): Promise<number> {
  requireInitialised(resolvePaths(opts.project));
  const { runStdio } = await import('../../mcp/main.js');
  await runStdio(opts.project, (root) => deps.keyStore(root));
  return 0;
}
