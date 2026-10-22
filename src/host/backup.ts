// Encrypted backups of store.db / auth.db taken before a schema migration or a data-folder migration.
// The copies stay encrypted with the same master key; nothing is decrypted or written in clear text.
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from '../core/constants.js';
import { deriveDbKey, openEncryptedDb } from '../crypto/index.js';

export const BACKUPS_DIR = 'backups';
export const KEEP_BACKUPS = 3;

/** The schema version stored in an existing store.db, read without migrating. null = no file, no meta table, or unreadable. */
export function readStoreSchemaVersion(storeFile: string, master: Buffer): number | null {
  if (!fs.existsSync(storeFile)) return null;
  try {
    const db = openEncryptedDb(storeFile, deriveDbKey(master, 'store'), { create: false });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const n = row ? Number(row.value) : NaN;
      return Number.isFinite(n) ? n : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function checkpointCopy(src: string, dst: string, key: Buffer): void {
  try {
    const db = openEncryptedDb(src, key, { create: false });
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch {
    // locked or unreadable: the -wal file is copied along below
  }
  fs.copyFileSync(src, dst);
  const wal = `${src}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) fs.copyFileSync(wal, `${dst}-wal`);
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** Backup folders, oldest first (names start with an ISO time, so name order is time order). */
export function listBackups(dataDir: string): { name: string; atMs: number }[] {
  const root = path.join(dataDir, BACKUPS_DIR);
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, atMs: fs.statSync(path.join(root, d.name)).mtimeMs }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return [];
  }
}

function rotate(dataDir: string, keep: number): void {
  const all = listBackups(dataDir);
  for (const b of all.slice(0, Math.max(0, all.length - keep))) {
    fs.rmSync(path.join(dataDir, BACKUPS_DIR, b.name), { recursive: true, force: true });
  }
}

export interface BackupResult {
  dir: string;
  files: string[];
}

/**
 * Copies store.db (and auth.db if present) to `<dataDir>/backups/<ISO>-<label>/` after a checkpoint, keeps the newest
 * `keep` backups and records `meta.last_backup_at` (unix seconds) in the live store. Returns null when nothing was backed up.
 */
export function backupDatabases(
  dataDir: string,
  master: Buffer,
  opts: { label: string; now?: () => number; keep?: number },
): BackupResult | null {
  const storeFile = path.join(dataDir, 'store.db');
  if (!fs.existsSync(storeFile)) return null;
  const now = (opts.now ?? Date.now)();
  const dir = path.join(dataDir, BACKUPS_DIR, `${stamp(now)}-${opts.label}`);
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  try {
    checkpointCopy(storeFile, path.join(dir, 'store.db'), deriveDbKey(master, 'store'));
    files.push('store.db');
    const authFile = path.join(dataDir, 'auth.db');
    if (fs.existsSync(authFile)) {
      checkpointCopy(authFile, path.join(dir, 'auth.db'), deriveDbKey(master, 'auth'));
      files.push('auth.db');
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  rotate(dataDir, opts.keep ?? KEEP_BACKUPS);
  try {
    const db = openEncryptedDb(storeFile, deriveDbKey(master, 'store'), { create: false });
    try {
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('last_backup_at', ?)").run(String(Math.floor(now / 1000)));
    } finally {
      db.close();
    }
  } catch {
    // the meta note is informational
  }
  return { dir, files };
}

/**
 * Backs up the databases when store.db is at an older schema than `toVersion` (default: this build's version).
 * Call before anything opens the store for migration. Never throws: a failed backup goes to `onError` and the
 * upgrade continues (the app must not refuse to start because a backup failed).
 */
export function backupBeforeMigration(
  dataDir: string,
  master: Buffer,
  opts: { toVersion?: number; now?: () => number; keep?: number; onError?: (e: unknown) => void } = {},
): BackupResult | null {
  const to = opts.toVersion ?? SCHEMA_VERSION;
  const current = readStoreSchemaVersion(path.join(dataDir, 'store.db'), master);
  if (current === null || current >= to) return null;
  try {
    return backupDatabases(dataDir, master, { label: `pre-v${to}`, now: opts.now, keep: opts.keep });
  } catch (err) {
    opts.onError?.(err);
    return null;
  }
}
