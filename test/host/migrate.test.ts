import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyringBackend } from '../../src/core/contracts.js';
import { resolveUserPaths } from '../../src/core/paths.js';
import { createMasterKeyStore, deriveDbKey, openEncryptedDb } from '../../src/crypto/index.js';
import { useDbAuthState } from '../../src/daemon/wa/index.js';
import { migrateLegacyDataDir } from '../../src/host/migrate.js';
import { SqliteStore } from '../../src/store/index.js';

const map = new Map<string, string>();
const keyring: KeyringBackend = {
  getPassword: (s, a) => map.get(`${s}/${a}`) ?? null,
  setPassword: (s, a, p) => void map.set(`${s}/${a}`, p),
  deletePassword: (s, a) => map.delete(`${s}/${a}`),
};

let root: string;
let legacy: string;
let newDir: string;

async function seedLegacy(): Promise<Buffer> {
  fs.mkdirSync(legacy, { recursive: true });
  const master = createMasterKeyStore(legacy, keyring).create();
  const sdb = openEncryptedDb(path.join(legacy, 'store.db'), deriveDbKey(master, 'store'));
  const store = new SqliteStore(sdb);
  store.migrate();
  store.upsertChat({ id: '1@g.us', type: 'group', name: 'ERP' });
  store.setMeta('risk_accepted_at', '123');
  sdb.close();
  const adb = openEncryptedDb(path.join(legacy, 'auth.db'), deriveDbKey(master, 'auth'));
  await useDbAuthState(adb);
  adb.close();
  fs.writeFileSync(path.join(legacy, 'config.yaml'), 'retention_days: 7\n');
  fs.mkdirSync(path.join(legacy, 'exports'));
  fs.writeFileSync(path.join(legacy, 'exports', 'a.txt'), 'x');
  fs.writeFileSync(path.join(legacy, 'daemon.lock'), '{}');
  return master;
}

beforeEach(() => {
  map.clear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-mig-'));
  legacy = path.join(root, 'legacy');
  newDir = path.join(root, 'new');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('migrateLegacyDataDir', () => {
  it('copies databases, configs, exports and the keychain key; leaves the old folder; is idempotent', async () => {
    const master = await seedLegacy();
    const paths = resolveUserPaths(newDir);
    const r = migrateLegacyDataDir(paths, { keyring, legacyDir: legacy });
    expect(r).toEqual({ migrated: true, from: path.resolve(legacy) });

    expect(createMasterKeyStore(newDir, keyring).get()?.equals(master)).toBe(true);
    const db = openEncryptedDb(paths.storeDb, deriveDbKey(master, 'store'), { create: false });
    const store = new SqliteStore(db);
    expect(store.getChat('1@g.us')?.name).toBe('ERP');
    expect(store.getMeta('migrated_from')).toBe(path.resolve(legacy));
    expect(store.getMeta('risk_accepted_at')).toBe('123');
    db.close();
    openEncryptedDb(paths.authDb, deriveDbKey(master, 'auth'), { create: false }).close();
    expect(fs.readFileSync(paths.config, 'utf8')).toContain('retention_days: 7');
    expect(fs.readFileSync(path.join(paths.exportsDir, 'a.txt'), 'utf8')).toBe('x');
    expect(fs.existsSync(path.join(newDir, 'daemon.lock'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'store.db'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, '.migrating'))).toBe(false);
    expect(fs.existsSync(path.join(newDir, '.migrate-tmp'))).toBe(false);

    const again = migrateLegacyDataDir(paths, { keyring, legacyDir: legacy });
    expect(again.migrated).toBe(false);
  });

  it('never overwrites an existing new store', async () => {
    await seedLegacy();
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(newDir, 'store.db'), 'not touched');
    expect(migrateLegacyDataDir(resolveUserPaths(newDir), { keyring, legacyDir: legacy }).migrated).toBe(false);
    expect(fs.readFileSync(path.join(newDir, 'store.db'), 'utf8')).toBe('not touched');
  });

  it('works while a lock file already exists in the new folder, and ignores a stale old lock', async () => {
    await seedLegacy();
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(newDir, 'daemon.lock'), '{"pid":1}');
    expect(migrateLegacyDataDir(resolveUserPaths(newDir), { keyring, legacyDir: legacy }).migrated).toBe(true);
    expect(fs.readFileSync(path.join(newDir, 'daemon.lock'), 'utf8')).toBe('{"pid":1}');
  });

  it('does nothing without a legacy store, without its key, or outside the Windows default folder', async () => {
    const paths = resolveUserPaths(newDir);
    expect(migrateLegacyDataDir(paths, { keyring, legacyDir: legacy }).migrated).toBe(false);
    await seedLegacy();
    map.clear();
    expect(migrateLegacyDataDir(paths, { keyring, legacyDir: legacy })).toMatchObject({ migrated: false });
    expect(fs.existsSync(paths.storeDb)).toBe(false);
    expect(migrateLegacyDataDir(paths, { keyring, platform: 'linux', env: { LOCALAPPDATA: root } }).migrated).toBe(false);
    expect(migrateLegacyDataDir(paths, { keyring, platform: 'win32', env: { LOCALAPPDATA: root, CHATAI_HOME: newDir } }).migrated).toBe(false);
  });
});
