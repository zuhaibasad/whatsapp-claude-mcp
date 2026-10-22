#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config/index.js';
import type { MasterKeyStore } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import { resolvePaths, resolveUserPaths, type DataPaths } from '../core/paths.js';
import { createMasterKeyStore, deriveDbKey, openEncryptedDb, DbMissingError } from '../crypto/index.js';
import { readLock } from '../daemon/lock.js';
import { SqliteStore } from '../store/index.js';
import { loadRealHost, type HostBridge } from './host.js';
import { createServer, ToolError, type McpDeps } from './server.js';

/** Builds the real dependencies. Nothing here touches stdout: it is the protocol channel. */
export function realDeps(target: string | DataPaths, keyStore?: (root: string) => MasterKeyStore): McpDeps {
  const paths = typeof target === 'string' ? resolvePaths(target) : target;
  let level = 'info';
  try {
    level = loadConfig(paths).config.logLevel;
  } catch {
    /* config problems are reported per call */
  }
  const logger = createLogger({ level, file: paths.logFile, name: 'chatai-mcp' });
  const keys = keyStore ?? createMasterKeyStore;
  return {
    projectRoot: paths.projectRoot,
    paths,
    now: () => Date.now(),
    readLock,
    log: (event, data) => logger.info(data ?? {}, event),
    openStore: ({ write }) => {
      if (!fs.existsSync(paths.storeDb)) throw new ToolError('not initialised: WhatsApp is not set up yet');
      const master = keys(paths.projectRoot).get();
      if (!master) throw new ToolError('encryption key not found in the OS keychain: WhatsApp needs to be set up again');
      try {
        const db = openEncryptedDb(paths.storeDb, deriveDbKey(master, 'store'), { readonly: !write, create: false });
        return { store: new SqliteStore(db), close: () => db.close() };
      } catch (e) {
        if (e instanceof DbMissingError) throw new ToolError('not initialised: WhatsApp is not set up yet');
        throw new ToolError(`cannot open the store: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    },
  };
}

/**
 * Runs the stdio server until the client disconnects, stdin ends, or SIGTERM/SIGINT.
 * With `withHost` the collector host starts in the background after the transport is connected (never blocks
 * the MCP handshake) and is stopped on exit.
 */
export async function runStdio(
  target: string | DataPaths,
  keyStore?: (root: string) => MasterKeyStore,
  opts: { withHost?: boolean } = {},
): Promise<void> {
  const paths = typeof target === 'string' ? resolvePaths(target) : target;
  const deps = realDeps(paths, keyStore);
  const ref: { host: HostBridge | null } = { host: null };
  deps.getHost = () => ref.host;
  const { server } = createServer(deps);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
  });
  await server.connect(new StdioServerTransport());
  if (opts.withHost) {
    loadRealHost(paths, (e) => deps.log?.('host_error', { error: e instanceof Error ? e.message : 'unknown' }))
      .then((h) => {
        ref.host = h;
      })
      .catch((e: unknown) => deps.log?.('host_unavailable', { error: e instanceof Error ? e.message : 'unknown' }));
  }
  await closed;
  try {
    await ref.host?.stop();
  } catch {
    /* shutting down */
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : undefined;
}

/** `--data-dir <dir>` = explicit user-style folder; `--project <dir>` = development (<dir>/.chatai); default = per-user folder. */
export function pathsFromArgs(argv: string[]): DataPaths {
  const dataDir = argValue(argv, '--data-dir');
  if (dataDir) return resolveUserPaths(dataDir);
  const project = argValue(argv, '--project');
  if (project) return resolvePaths(project);
  return resolveUserPaths();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href) {
  runStdio(pathsFromArgs(process.argv), undefined, { withHost: true }).catch((e: unknown) => {
    process.stderr.write(`chatai mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
