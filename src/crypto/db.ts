import fs from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Db } from '../core/contracts.js';

export class WrongKeyError extends Error {
  constructor() {
    super('Cannot open database: wrong key or not an encrypted database.');
    this.name = 'WrongKeyError';
  }
}
export class DbMissingError extends Error {
  constructor(file: string) {
    super(`Database file does not exist: ${file}`);
    this.name = 'DbMissingError';
  }
}

export function openEncryptedDb(
  file: string,
  key: Buffer,
  opts: { readonly?: boolean; create?: boolean } = {},
): Db {
  if (key.length !== 32) throw new Error('Database key must be 32 bytes.');
  const readonly = opts.readonly ?? false;
  const create = opts.create ?? true;
  if ((!create || readonly) && !fs.existsSync(file)) throw new DbMissingError(file);

  const db = new Database(file, { readonly, fileMustExist: !create || readonly });
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.pragma(`key="x'${key.toString('hex')}'"`);
    db.prepare('select count(*) from sqlite_master').get();
    db.pragma('busy_timeout=5000');
    if (!readonly) {
      db.pragma('journal_mode=WAL');
      db.pragma('synchronous=NORMAL');
      db.pragma('foreign_keys=ON');
    }
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    const code = (e as { code?: string }).code;
    if (code === 'SQLITE_NOTADB' || /not a database/i.test((e as Error).message)) {
      throw new WrongKeyError();
    }
    throw e;
  }
  return db;
}
