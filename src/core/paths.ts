import path from 'node:path';
import { DATA_DIR_NAME } from './constants.js';

export interface DataPaths {
  projectRoot: string;
  dataDir: string;
  storeDb: string;
  authDb: string;
  config: string;
  departments: string;
  priorities: string;
  exportsDir: string;
  lockFile: string;
  qrPng: string;
  logFile: string;
  serviceInfo: string;   // service.json (ServiceInfo)
  appDir: string;        // installed payload versions: <dataDir>/app/<version>
}

/**
 * Per-user data folder used by the installed product (service, MCP server, CLI):
 * Windows %LOCALAPPDATA%\wa-bridge · macOS ~/Library/Application Support/wa-bridge · Linux $XDG_DATA_HOME/wa-bridge.
 * WA_BRIDGE_HOME overrides it (tests, development).
 */
/** Old Windows default (0.1.0). Inside Claude Desktop it maps to the MSIX-redirected folder; migrated on start. */
export function legacyWindowsDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'wa-bridge') : null;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.WA_BRIDGE_HOME) return path.resolve(env.WA_BRIDGE_HOME);
  const home = env.USERPROFILE ?? env.HOME ?? '.';
  // Not %LOCALAPPDATA%: Claude Desktop (MSIX) silently redirects NEW folders under AppData into its package
  // (Packages\Claude_*\LocalCache), so Claude Code and the CLI would see a different folder (R3 addendum).
  if (platform === 'win32') return path.join(home, '.wa-bridge');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'wa-bridge');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'wa-bridge');
}

/** Paths for the per-user install. `projectRoot` is set to the data dir itself (also used for the keychain id). */
export function resolveUserPaths(dataDir: string = defaultDataDir()): DataPaths {
  return buildPaths(path.resolve(dataDir), path.resolve(dataDir));
}

/** Development / per-project mode: data lives in `<projectRoot>/.wa-bridge`. */
export function resolvePaths(projectRoot: string = process.cwd()): DataPaths {
  const root = path.resolve(projectRoot);
  return buildPaths(root, path.join(root, DATA_DIR_NAME));
}

function buildPaths(root: string, dataDir: string): DataPaths {
  return {
    projectRoot: root,
    dataDir,
    storeDb: path.join(dataDir, 'store.db'),
    authDb: path.join(dataDir, 'auth.db'),
    config: path.join(dataDir, 'config.yaml'),
    departments: path.join(dataDir, 'departments.yaml'),
    priorities: path.join(dataDir, 'priorities.yaml'),
    exportsDir: path.join(dataDir, 'exports'),
    lockFile: path.join(dataDir, 'daemon.lock'),
    qrPng: path.join(dataDir, 'qr.png'),
    logFile: path.join(dataDir, 'daemon.log'),
    serviceInfo: path.join(dataDir, 'service.json'),
    appDir: path.join(dataDir, 'app'),
  };
}
