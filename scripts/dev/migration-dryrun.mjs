// Usage: node scripts/dev/migration-dryrun.mjs <temp-dir>   (run 'npm run build' first; Windows; reads the Claude Desktop sandbox copy)
// Dry run of the 0.1 -> 0.2 data-dir migration on a COPY of the real Claude Desktop data. Prints counts only.
import fs from 'node:fs';
import path from 'node:path';

const base = 'file:///C:/tempfolder/wa-bridge/dist/';
const { createMasterKeyStore, napiKeyringBackend, keychainAccountId, deriveDbKey, openEncryptedDb } = await import(base + 'crypto/index.js');
const { resolveUserPaths } = await import(base + 'core/paths.js');
const { KEYCHAIN_SERVICE } = await import(base + 'core/constants.js');
const { migrateLegacyDataDir } = await import(base + 'host/migrate.js');
const { SqliteStore } = await import(base + 'store/index.js');

const L = process.env.LOCALAPPDATA;
const realVirtual = path.join(L, 'chatai');
const physical = path.join(L, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local', 'chatai');
const tmp = path.join(process.argv[2]);
const legacy = path.join(tmp, 'legacy');
const newDir = path.join(tmp, 'new');
const kr = napiKeyringBackend();
const idLegacy = keychainAccountId(legacy);
const idNew = keychainAccountId(newDir);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(legacy, { recursive: true });
  for (const f of fs.readdirSync(physical)) {
    const src = path.join(physical, f);
    if (fs.statSync(src).isFile() && !f.endsWith('.lock') && f !== 'service.json') fs.copyFileSync(src, path.join(legacy, f));
  }
  const master = createMasterKeyStore(realVirtual).get();
  if (!master) throw new Error('real key not found');
  kr.setPassword(KEYCHAIN_SERVICE, idLegacy, master.toString('base64'));

  const before = (() => {
    const db = openEncryptedDb(path.join(legacy, 'store.db'), deriveDbKey(master, 'store'), { readonly: true });
    const r = { messages: db.prepare('select count(*) n from messages').get().n, chats: db.prepare('select count(*) n from chats').get().n,
      schema: db.prepare("select value from meta where key='schema_version'").get()?.value };
    db.close();
    return r;
  })();
  console.log('legacy copy:', JSON.stringify(before));

  const res = migrateLegacyDataDir(resolveUserPaths(newDir), { keyring: kr, legacyDir: legacy });
  console.log('migration result:', JSON.stringify(res));

  const newKey = createMasterKeyStore(newDir).get();
  console.log('key copied and identical:', !!newKey && newKey.equals(master));
  const db = openEncryptedDb(path.join(newDir, 'store.db'), deriveDbKey(newKey, 'store'));
  const store = new SqliteStore(db);
  store.migrate();
  const q = (s) => db.prepare(s).all();
  console.log('after v2 migrate: schema', db.prepare("select value from meta where key='schema_version'").get()?.value,
    '| messages', db.prepare('select count(*) n from messages').get().n,
    '| migrated_from set', !!db.prepare("select value from meta where key='migrated_from'").get());
  console.log('chats by type:', JSON.stringify(q('select type, count(*) n, sum(last_activity_at is not null) with_activity, sum(name is not null) named from chats group by type')));
  console.log('contacts rows:', db.prepare('select count(*) n from contacts').get().n);
  const auth = openEncryptedDb(path.join(newDir, 'auth.db'), deriveDbKey(newKey, 'auth'), { readonly: true });
  console.log('auth.db opens, creds present:', !!auth.prepare("select 1 from auth_kv where key='creds'").get());
  auth.close();
  db.close();
  console.log('legacy folder left in place:', fs.existsSync(path.join(legacy, 'store.db')));
} finally {
  for (const id of [idLegacy, idNew]) { try { kr.deletePassword(KEYCHAIN_SERVICE, id); } catch { /* ignore */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('cleanup done (temp keys and files removed)');
}
