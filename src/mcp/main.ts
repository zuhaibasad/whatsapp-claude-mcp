#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config/index.js';
import type { MasterKeyStore } from '../core/contracts.js';
import { createLogger } from '../core/logger.js';
import { resolvePaths } from '../core/paths.js';
import { createMasterKeyStore, deriveDbKey, openEncryptedDb, DbMissingError } from '../crypto/index.js';
import { readLock } from '../daemon/lock.js';
import { SqliteStore } from '../store/index.js';
import { createServer, ToolError, type McpDeps } from './server.js';

/** Builds the real dependencies. Nothing here touches stdout: it is the protocol channel. */
export function realDeps(projectRoot: string, keyStore?: (root: string) => MasterKeyStore): McpDeps {
  const paths = resolvePaths(projectRoot);
  let level = 'info';
  try {
    level = loadConfig(paths).config.logLevel;
  } catch {
    /* config problems are reported per call */
  }
  const logger = createLogger({ level, file: paths.logFile, name: 'wa-bridge-mcp' });
  const keys = keyStore ?? createMasterKeyStore;
  return {
    projectRoot: paths.projectRoot,
    now: () => Date.now(),
    readLock,
    log: (event, data) => logger.info(data ?? {}, event),
    openStore: ({ write }) => {
      if (!fs.existsSync(paths.storeDb)) throw new ToolError('not initialised: run `wa-bridge init`');
      const master = keys(paths.projectRoot).get();
      if (!master) throw new ToolError('encryption key not found in the OS keychain: run `wa-bridge init`');
      try {
        const db = openEncryptedDb(paths.storeDb, deriveDbKey(master, 'store'), { readonly: !write, create: false });
        return { store: new SqliteStore(db), close: () => db.close() };
      } catch (e) {
        if (e instanceof DbMissingError) throw new ToolError('not initialised: run `wa-bridge init`');
        throw new ToolError(`cannot open the store: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    },
  };
}

/** Runs the stdio server until the client disconnects. */
export async function runStdio(projectRoot: string, keyStore?: (root: string) => MasterKeyStore): Promise<void> {
  const { server } = createServer(realDeps(projectRoot, keyStore));
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  await closed;
}

function argProject(argv: string[]): string {
  const i = argv.indexOf('--project');
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : process.cwd();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href) {
  runStdio(argProject(process.argv)).catch((e: unknown) => {
    process.stderr.write(`wa-bridge mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
