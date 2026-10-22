import fs from 'node:fs';
import { deriveDbKey, openEncryptedDb, DbMissingError } from '../crypto/index.js';
import type { Db } from '../core/contracts.js';
import type { DataPaths } from '../core/paths.js';
import { SqliteStore } from '../store/index.js';
import type { CliDeps } from './deps.js';
import { CliError } from './io.js';

export function isInitialised(paths: DataPaths): boolean {
  return fs.existsSync(paths.storeDb);
}

export function requireInitialised(paths: DataPaths): void {
  if (!isInitialised(paths)) throw new CliError('Not initialised. Run: chatai init', 2);
}

export function masterKey(paths: DataPaths, deps: CliDeps): Buffer {
  const key = deps.keyStore(paths.projectRoot).get();
  if (!key) throw new CliError('Master key not found in the OS keychain. Run: chatai init', 2);
  return key;
}

export interface OpenedStore {
  store: SqliteStore;
  close(): void;
}

/** Opens store.db. Read commands pass write:false (read-only connection). */
export function openStore(paths: DataPaths, deps: CliDeps, opts: { write: boolean }): OpenedStore {
  requireInitialised(paths);
  const key = deriveDbKey(masterKey(paths, deps), 'store');
  let db: Db;
  try {
    db = openEncryptedDb(paths.storeDb, key, { readonly: !opts.write, create: false });
  } catch (e) {
    if (e instanceof DbMissingError) throw new CliError('Not initialised. Run: chatai init', 2);
    throw e;
  }
  return { store: new SqliteStore(db), close: () => db.close() };
}

export function openAuthDb(paths: DataPaths, deps: CliDeps, opts: { create: boolean }): Db {
  return openEncryptedDb(paths.authDb, deriveDbKey(masterKey(paths, deps), 'auth'), { create: opts.create });
}
