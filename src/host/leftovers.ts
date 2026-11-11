// Finds data left behind by earlier installs (or by an install whose keychain key was deleted) and removes it
// ONLY for folders this module found itself. Names of files to delete are a fixed list: never a user-supplied path,
// never a recursive delete of a whole folder we do not own.
import fs from 'node:fs';
import path from 'node:path';
import { KEYCHAIN_SERVICE } from '../core/constants.js';
import type { KeyringBackend } from '../core/contracts.js';
import { anchorDataDir, legacyWindowsDataDir, type DataPaths } from '../core/paths.js';
import { SERVICE_TOKEN_SUFFIX } from '../core/service.js';
import { createMasterKeyStore, deriveDbKey, keychainAccountId, openEncryptedDb } from '../crypto/index.js';
import { readLock } from '../daemon/lock.js';

export type LeftoverKind =
  /** The current folder holds a database that this machine's keychain key cannot open. Setup cannot continue. */
  | 'unreadable'
  /** A folder from an earlier version or location. Harmless; may be a backup. */
  | 'old';

export interface Leftover {
  kind: LeftoverKind;
  dir: string;
  bytes: number;
  /** Plain-language reason, shown to the user. */
  why: string;
}

const FILES = [
  'store.db', 'store.db-wal', 'store.db-shm', 'store.db-journal',
  'auth.db', 'auth.db-wal', 'auth.db-shm', 'auth.db-journal',
  'config.yaml', 'departments.yaml', 'priorities.yaml',
  'daemon.lock', 'daemon.log', 'qr.png', 'service.json', '.migrating',
];
const DIRS = ['exports', 'backups', 'app', '.migrate-tmp'];
const DATA_MARKERS = ['store.db', 'auth.db'];

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
  } catch {
    return 0;
  }
}

function hasData(dir: string): boolean {
  return DATA_MARKERS.some((f) => fs.existsSync(path.join(dir, f)));
}

function folderBytes(dir: string): number {
  return [...FILES, ...DIRS].reduce((n, f) => n + sizeOf(path.join(dir, f)), 0);
}

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Folders earlier versions used. The first two are the 0.1 location and the pre-rename product name. */
export function oldFolderCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? '';
  const out: (string | null)[] = [anchorDataDir(env, platform)];
  if (platform === 'win32') {
    out.push(legacyWindowsDataDir(env));
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'wa-bridge'));
    if (home) out.push(path.join(home, '.wa-bridge'));
  } else if (platform === 'darwin') {
    if (home) out.push(path.join(home, 'Library', 'Application Support', 'wa-bridge'), path.join(home, '.wa-bridge'));
  } else if (home) {
    out.push(path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'wa-bridge'), path.join(home, '.wa-bridge'));
  }
  return out.filter((x): x is string => !!x);
}

export interface ScanOpts {
  keyring: KeyringBackend;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Folders the user already chose to keep. */
  declined?: string[];
}

/** Read-only. Never throws. */
export function scanLeftovers(paths: DataPaths, opts: ScanOpts): Leftover[] {
  const current = norm(paths.dataDir);
  const declined = new Set((opts.declined ?? []).map(norm));
  const found: Leftover[] = [];

  // 1. The current folder has databases but the key is gone or does not fit.
  try {
    if (hasData(paths.dataDir) && !readLock(paths.lockFile)?.alive) {
      const key = createMasterKeyStore(paths.projectRoot, opts.keyring).get();
      let why: string | null = null;
      if (!key) {
        why = 'It holds saved WhatsApp data from an earlier install, but its encryption key is no longer on this computer, so it can never be opened.';
      } else if (fs.existsSync(paths.storeDb)) {
        try {
          openEncryptedDb(paths.storeDb, deriveDbKey(key, 'store'), { create: false, readonly: true }).close();
        } catch {
          why = 'It holds saved WhatsApp data that the current encryption key cannot open.';
        }
      }
      if (why) found.push({ kind: 'unreadable', dir: paths.dataDir, bytes: folderBytes(paths.dataDir), why });
    }
  } catch {
    /* keychain unavailable: skip this check rather than offer to delete data we could not inspect */
  }

  // 2. Folders from earlier versions or locations.
  const seen = new Set<string>([current]);
  for (const dir of oldFolderCandidates(opts.env, opts.platform)) {
    const n = norm(dir);
    if (seen.has(n)) continue;
    seen.add(n);
    if (declined.has(n) || !fs.existsSync(dir) || !hasData(dir)) continue;
    found.push({ kind: 'old', dir, bytes: folderBytes(dir), why: 'Saved WhatsApp data from an earlier version or location of ChatAI.' });
  }
  return found;
}

/** Removes the data files of one scanned folder and its keychain entries. Returns the number of entries removed. */
export function removeLeftover(item: Leftover, keyring: KeyringBackend): number {
  let removed = 0;
  const lock = readLock(path.join(item.dir, 'daemon.lock'));
  if (lock?.alive) throw new Error('that folder is in use by a running ChatAI; quit Claude first');
  for (const f of FILES) {
    const p = path.join(item.dir, f);
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed++; }
  }
  for (const d of DIRS) {
    const p = path.join(item.dir, d);
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
  }
  try { fs.rmdirSync(item.dir); } catch { /* not empty (e.g. location.json): leave it */ }
  const account = keychainAccountId(item.dir);
  for (const a of [account, `${account}${SERVICE_TOKEN_SUFFIX}`]) {
    try { if (keyring.deletePassword(KEYCHAIN_SERVICE, a)) removed++; } catch { /* already gone */ }
  }
  return removed;
}

export function describeBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
