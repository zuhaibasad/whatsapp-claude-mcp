# T2 — Keychain + encrypted DB open

**Model tier:** Sonnet · **Depends on:** nothing · **Owned files:** `src/crypto/**`, `test/crypto/**`

Contracts: `KeyringBackend`, `MasterKeyStore`, `DbPurpose`, `Db` in `src/core/contracts.ts`. Read PLAN §4.

## Deliverables (`src/crypto/`)
1. `keychain.ts`
   - `napiKeyringBackend(): KeyringBackend` wraps `@napi-rs/keyring` `Entry`. `getPassword` returns null when no entry exists; check how the lib signals that and handle both throw and null. `deletePassword` returns a boolean.
   - `keychainAccountId(projectRoot: string): string` returns `'project-' + sha256(path.resolve(projectRoot).toLowerCase() on win32 else as-is).slice(0, 16)`.
   - `createMasterKeyStore(projectRoot: string, backend: KeyringBackend = napiKeyringBackend()): MasterKeyStore`. It stores the key as base64 under service `KEYCHAIN_SERVICE`. `create()` uses `crypto.randomBytes(32)` and throws `KeyExistsError` if a key exists. `get()` validates 32 bytes after decode and throws `CorruptKeyError` otherwise.
   - Errors: `export class KeychainUnavailableError extends Error`. Wrap any backend failure with a helpful message (Linux: "install and unlock a Secret Service such as gnome-keyring").
2. `kdf.ts`: `deriveDbKey(master: Buffer, purpose: DbPurpose): Buffer` uses `crypto.hkdfSync('sha256', master, salt='wa-bridge/v1', info=purpose, 32)`. It is deterministic, and different per purpose.
3. `db.ts`: `openEncryptedDb(file: string, key: Buffer, opts?: { readonly?: boolean; create?: boolean }): Db`
   - It uses `better-sqlite3-multiple-ciphers` (default import). In this order: `pragma cipher='sqlcipher'`, `pragma legacy=4`, then the **raw hex key** `pragma key="x'<64 hex>'"`. Check the raw-key syntax works with sqlite3mc's sqlcipher scheme. If it does not, fall back to a hex-string passphrase and record it in notes.
   - Then verify with `select count(*) from sqlite_master`. On `SQLITE_NOTADB` it closes and throws `WrongKeyError`.
   - Not readonly: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`. Always `busy_timeout=5000`.
   - `create:false` (default true): throw `DbMissingError` if the file does not exist. Readers like the CLI and MCP must not create files by accident.
   - Never log the key. Never put it in an error message.
4. `index.ts` re-exports the public API.

## Tests (`test/crypto/`), using a temp dir per test (`fs.mkdtempSync(os.tmpdir())`) and a **fake in-memory KeyringBackend**
- create → get round-trip. create twice throws. delete. Different project roots give different keys. A corrupt stored value throws CorruptKeyError.
- deriveDbKey is deterministic. store ≠ auth. Length 32.
- An encrypted DB with FTS5 table insert, close and reopen with the right key works. The **file bytes do not contain the plaintext**. A wrong key throws WrongKeyError. No key throws.
- WAL works with encryption: one writer connection and one reader connection see the committed rows. Also check that the `-wal` file contains no plaintext after a write.
- `create:false` on a missing file throws DbMissingError.
- One **real keychain** test, skipped unless `process.env.WA_BRIDGE_TEST_KEYCHAIN === '1'`. It uses service `wa-bridge-test` and always cleans up.

## Acceptance
`npm run check` passes. Write `.agents/notes/T2.md` with the exact public API (T6, T7 and T8 use it).
