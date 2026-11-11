import fs from 'node:fs';
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
 * Windows %LOCALAPPDATA%\chatai · macOS ~/Library/Application Support/chatai · Linux $XDG_DATA_HOME/chatai.
 * CHATAI_HOME overrides it (tests, development).
 */
/** Old Windows default (0.1.0). Inside Claude Desktop it maps to the MSIX-redirected folder; migrated on start. */
export function legacyWindowsDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'chatai') : null;
}

/** The fixed per-OS folder. It holds the data by default and always holds `location.json` (the chosen-folder pointer). */
export function anchorDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env.USERPROFILE ?? env.HOME ?? '.';
  // Not %LOCALAPPDATA%: Claude Desktop (MSIX) silently redirects NEW folders under AppData into its package
  // (Packages\Claude_*\LocalCache), so Claude Code and the CLI would see a different folder (R3 addendum).
  if (platform === 'win32') return path.join(home, '.chatai');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'chatai');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'chatai');
}

/** What the user chose about where ChatAI keeps its data, stored in `<anchor>/location.json`. */
export interface LocationChoice {
  /** Chosen data folder (absolute). Absent = not chosen yet. */
  dataDir?: string;
  /** Leftover folders the user already said "keep" to, so they are not asked again. */
  declined: string[];
}

export function locationFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(anchorDataDir(env, platform), 'location.json');
}

export function readLocation(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LocationChoice {
  try {
    const j = JSON.parse(fs.readFileSync(locationFile(env, platform), 'utf8')) as Record<string, unknown>;
    const dataDir = typeof j['dataDir'] === 'string' && path.isAbsolute(j['dataDir']) ? j['dataDir'] : undefined;
    const declined = Array.isArray(j['declined']) ? j['declined'].filter((x): x is string => typeof x === 'string') : [];
    return dataDir ? { dataDir, declined } : { declined };
  } catch {
    return { declined: [] };
  }
}

export function writeLocation(patch: Partial<LocationChoice>, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  const next: LocationChoice = { ...readLocation(env, platform), ...patch };
  fs.mkdirSync(anchorDataDir(env, platform), { recursive: true });
  fs.writeFileSync(locationFile(env, platform), JSON.stringify(next, null, 2));
}

/** CHATAI_HOME, else the folder the user chose, else the anchor. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CHATAI_HOME) return path.resolve(env.CHATAI_HOME);
  return readLocation(env, platform).dataDir ?? anchorDataDir(env, platform);
}

/** Paths for the per-user install. `projectRoot` is set to the data dir itself (also used for the keychain id). */
export function resolveUserPaths(dataDir: string = defaultDataDir()): DataPaths {
  return buildPaths(path.resolve(dataDir), path.resolve(dataDir));
}

/** Development / per-project mode: data lives in `<projectRoot>/.chatai`. */
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
