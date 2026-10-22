// One-time copy of the old Windows data folder (%LOCALAPPDATA%\wa-bridge, possibly MSIX-redirected) into the
// current default (%USERPROFILE%\.wa-bridge). Copies, never moves; the old folder stays as a backup.
import fs from 'node:fs';
import path from 'node:path';
import { KEYCHAIN_SERVICE } from '../core/constants.js';
import type { KeyringBackend } from '../core/contracts.js';
import { defaultDataDir, legacyWindowsDataDir, type DataPaths } from '../core/paths.js';
import { createMasterKeyStore, deriveDbKey, keychainAccountId, openEncryptedDb } from '../crypto/index.js';
import { SqliteStore } from '../store/index.js';
import { backupBeforeMigration } from './backup.js';

interface Log {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
}

export interface MigrateOpts {
  keyring: KeyringBackend;
  logger?: Log;
  /** Override the old folder (tests). Default: legacyWindowsDataDir(), Windows only, user mode only. */
  legacyDir?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export type MigrateResult =
  | { migrated: true; from: string }
  | { migrated: false; reason: string };

const CONFIG_FILES = ['config.yaml', 'departments.yaml', 'priorities.yaml'];
const STALE_MARKER_MS = 5 * 60_000;

function skip(reason: string): MigrateResult {
  return { migrated: false, reason };
}

/** Opens and closes the DB once so WAL content is merged into the main file. Best effort. */
function checkpoint(file: string, key: Buffer): void {
  try {
    const db = openEncryptedDb(file, key, { create: false });
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch {
    // locked or unreadable: the -wal/-shm files are copied along instead
  }
}

function copyDb(srcDir: string, dstDir: string, name: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const src = path.join(srcDir, name + suffix);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, name + suffix));
  }
}

function moveDb(srcDir: string, dstDir: string, name: string): void {
  for (const suffix of ['-wal', '-shm', '']) { // main file last: its presence marks "migrated"
    const src = path.join(srcDir, name + suffix);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(dstDir, name + suffix));
  }
}

function verifyOpens(file: string, key: Buffer): void {
  const db = openEncryptedDb(file, key, { create: false, readonly: true });
  db.close();
}

/**
 * Copies store.db, auth.db, config yaml files and exports/ from the old data folder to `paths.dataDir`,
 * and the keychain master key to the new folder's keychain account. Idempotent; never overwrites an
 * existing new store. Never throws (a failure is logged and the app starts with a fresh folder).
 * Only runs for the per-user default folder on Windows (not with WA_BRIDGE_HOME or project mode).
 */
export function migrateLegacyDataDir(paths: DataPaths, opts: MigrateOpts): MigrateResult {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const log = opts.logger;
  const newDir = path.resolve(paths.dataDir);
  let legacy: string | null;
  if (opts.legacyDir !== undefined) {
    legacy = opts.legacyDir;
  } else if (platform !== 'win32' || env['WA_BRIDGE_HOME'] || newDir !== path.resolve(defaultDataDir(env, platform))) {
    legacy = null;
  } else {
    legacy = legacyWindowsDataDir(env);
  }
  if (!legacy) return skip('no legacy folder for this setup');
  legacy = path.resolve(legacy);
  if (legacy === newDir) return skip('legacy folder is the current folder');
  if (!fs.existsSync(path.join(legacy, 'store.db'))) return skip('no legacy store.db');
  if (fs.existsSync(path.join(newDir, 'store.db')) || fs.existsSync(path.join(newDir, 'auth.db'))) {
    return skip('new folder already has data');
  }

  const marker = path.join(newDir, '.migrating');
  const staging = path.join(newDir, '.migrate-tmp');
  const now = opts.now ?? Date.now;
  try {
    fs.mkdirSync(newDir, { recursive: true });
    try {
      fs.writeFileSync(marker, String(now()), { flag: 'wx' });
    } catch {
      const age = now() - fs.statSync(marker).mtimeMs;
      if (age < STALE_MARKER_MS) return skip('another process is migrating');
      fs.writeFileSync(marker, String(now()));
    }
    try {
      return run(legacy, newDir, staging, opts);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  } catch (err) {
    log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'data folder migration failed; old folder left untouched');
    return skip('migration failed');
  }
}

function run(legacy: string, newDir: string, staging: string, opts: MigrateOpts): MigrateResult {
  const log = opts.logger;
  const legacyKeys = createMasterKeyStore(legacy, opts.keyring);
  const master = legacyKeys.get();
  if (!master) return skip('legacy master key not found in the keychain');

  const storeKey = deriveDbKey(master, 'store');
  const authKey = deriveDbKey(master, 'auth');
  const hasAuth = fs.existsSync(path.join(legacy, 'auth.db'));

  checkpoint(path.join(legacy, 'store.db'), storeKey);
  if (hasAuth) checkpoint(path.join(legacy, 'auth.db'), authKey);

  // 1. copy into a staging folder and check the copies open with the legacy key
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  copyDb(legacy, staging, 'store.db');
  if (hasAuth) copyDb(legacy, staging, 'auth.db');
  verifyOpens(path.join(staging, 'store.db'), storeKey);
  if (hasAuth) verifyOpens(path.join(staging, 'auth.db'), authKey);

  // 2. keychain: same key under the new folder's account; read it back through the normal store
  const newAccount = keychainAccountId(newDir);
  opts.keyring.setPassword(KEYCHAIN_SERVICE, newAccount, master.toString('base64'));
  const readBack = createMasterKeyStore(newDir, opts.keyring).get();
  if (!readBack || !readBack.equals(master)) throw new Error('new keychain entry did not read back');

  // 3. config files and exports (existing files in the new folder win)
  for (const f of CONFIG_FILES) {
    const src = path.join(legacy, f);
    const dst = path.join(newDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
  const exportsSrc = path.join(legacy, 'exports');
  if (fs.existsSync(exportsSrc)) {
    fs.cpSync(exportsSrc, path.join(newDir, 'exports'), { recursive: true, force: false, errorOnExist: false });
  }

  // 4. move the databases into place (store.db last) and record where they came from
  if (hasAuth) moveDb(staging, newDir, 'auth.db');
  moveDb(staging, newDir, 'store.db');
  backupBeforeMigration(newDir, readBack, { now: opts.now, onError: (e) => log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'backup before migration failed') });
  const db = openEncryptedDb(path.join(newDir, 'store.db'), deriveDbKey(readBack, 'store'));
  try {
    const store = new SqliteStore(db);
    store.migrate();
    store.setMeta('migrated_from', legacy);
  } finally {
    db.close();
  }
  if (hasAuth) verifyOpens(path.join(newDir, 'auth.db'), deriveDbKey(readBack, 'auth'));

  log?.info({ from: legacy, to: newDir }, 'data folder migrated (old folder left in place)');
  return { migrated: true, from: legacy };
}
