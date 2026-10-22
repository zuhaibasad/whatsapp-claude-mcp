import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyringBackend } from '../../src/core/contracts.js';
import {
  CorruptKeyError, DbMissingError, KeyExistsError, WrongKeyError,
  createMasterKeyStore, deriveDbKey, napiKeyringBackend, openEncryptedDb,
} from '../../src/crypto/index.js';

function fakeBackend(): KeyringBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getPassword: (s, a) => map.get(`${s}|${a}`) ?? null,
    setPassword: (s, a, p) => void map.set(`${s}|${a}`, p),
    deletePassword: (s, a) => map.delete(`${s}|${a}`),
  };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-crypto-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('master key store', () => {
  it('create/get round trip, double create, delete', () => {
    const s = createMasterKeyStore(dir, fakeBackend());
    expect(s.get()).toBeNull();
    const k = s.create();
    expect(k.length).toBe(32);
    expect(s.get()?.equals(k)).toBe(true);
    expect(() => s.create()).toThrow(KeyExistsError);
    expect(s.delete()).toBe(true);
    expect(s.delete()).toBe(false);
    expect(s.get()).toBeNull();
  });
  it('different roots give different keys', () => {
    const b = fakeBackend();
    const a = createMasterKeyStore(path.join(dir, 'a'), b).create();
    const c = createMasterKeyStore(path.join(dir, 'b'), b).create();
    expect(a.equals(c)).toBe(false);
    expect(b.map.size).toBe(2);
  });
  it('corrupt value throws', () => {
    const b = fakeBackend();
    const s = createMasterKeyStore(dir, b);
    s.create();
    for (const k of b.map.keys()) b.map.set(k, 'AAAA');
    expect(() => s.get()).toThrow(CorruptKeyError);
  });
});

describe('kdf', () => {
  it('deterministic, per purpose, 32 bytes', () => {
    const m = Buffer.alloc(32, 7);
    const s1 = deriveDbKey(m, 'store');
    expect(s1.equals(deriveDbKey(m, 'store'))).toBe(true);
    expect(s1.equals(deriveDbKey(m, 'auth'))).toBe(false);
    expect(s1.length).toBe(32);
  });
});

describe('encrypted db', () => {
  const key = deriveDbKey(Buffer.alloc(32, 1), 'store');
  const SECRET = 'zebra-plaintext-marker-42';

  it('fts5 roundtrip, no plaintext, wrong/no key fails', () => {
    const f = path.join(dir, 's.db');
    const db = openEncryptedDb(f, key);
    db.exec('create table m(id integer primary key, text text); create virtual table f using fts5(text)');
    db.prepare('insert into m(text) values (?)').run(SECRET);
    db.prepare('insert into f(text) values (?)').run(SECRET);
    db.close();
    expect(fs.readFileSync(f).includes(SECRET)).toBe(false);
    const db2 = openEncryptedDb(f, key);
    expect(db2.prepare("select count(*) c from f where f match 'zebra'").get()).toEqual({ c: 1 });
    db2.close();
    expect(() => openEncryptedDb(f, deriveDbKey(Buffer.alloc(32, 2), 'store'))).toThrow(WrongKeyError);
    expect(() => openEncryptedDb(f, Buffer.alloc(0))).toThrow();
  });

  it('WAL with separate writer and reader; wal has no plaintext', () => {
    const f = path.join(dir, 'w.db');
    const w = openEncryptedDb(f, key);
    w.exec('create table m(text text)');
    w.prepare('insert into m values (?)').run(SECRET);
    const r = openEncryptedDb(f, key, { readonly: true });
    expect(r.prepare('select text from m').all()).toEqual([{ text: SECRET }]);
    expect(w.pragma('journal_mode', { simple: true })).toBe('wal');
    const wal = f + '-wal';
    expect(fs.existsSync(wal)).toBe(true);
    expect(fs.readFileSync(wal).includes(SECRET)).toBe(false);
    r.close();
    w.close();
  });

  it('create:false on missing file', () => {
    const f = path.join(dir, 'none.db');
    expect(() => openEncryptedDb(f, key, { create: false })).toThrow(DbMissingError);
    expect(fs.existsSync(f)).toBe(false);
  });
});

describe.skipIf(process.env.CHATAI_TEST_KEYCHAIN !== '1')('real keychain', () => {
  it('stores and retrieves via OS keychain', () => {
    const store = createMasterKeyStore(dir, napiKeyringBackend(), 'chatai-test');
    try {
      expect(store.get()).toBeNull();
      const k = store.create();
      expect(store.get()?.equals(k)).toBe(true);
    } finally {
      store.delete();
    }
    expect(store.get()).toBeNull();
  });
});
