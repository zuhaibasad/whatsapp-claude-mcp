// Shared first-run initialisation: keychain key, encrypted databases, default configs.
// Used by the CLI `init` command and by the collector host's setup flow.
import fs from 'node:fs';
import type { MasterKeyStore } from '../core/contracts.js';
import type { DataPaths } from '../core/paths.js';
import { writeDefaultConfigs } from '../config/index.js';
import { deriveDbKey, openEncryptedDb } from '../crypto/index.js';
import { useDbAuthState } from '../daemon/wa/index.js';
import { SqliteStore } from '../store/index.js';

/** True when the key exists and the store file is present. */
export function isInitialised(paths: DataPaths, keyStore: MasterKeyStore): boolean {
  return fs.existsSync(paths.storeDb) && keyStore.get() !== null;
}

/**
 * Creates the data folder, the master key (if missing), both encrypted databases and the default config files.
 * Safe to call again. If `riskAcceptedAtMs` is given, `meta.risk_accepted_at` is written (seconds).
 * Returns the master key.
 */
export async function initDataFiles(
  paths: DataPaths,
  keyStore: MasterKeyStore,
  opts: { riskAcceptedAtMs?: number } = {},
): Promise<Buffer> {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const master = keyStore.get() ?? keyStore.create();

  const storeDb = openEncryptedDb(paths.storeDb, deriveDbKey(master, 'store'));
  try {
    const store = new SqliteStore(storeDb);
    store.migrate();
    if (opts.riskAcceptedAtMs !== undefined) {
      store.setMeta('risk_accepted_at', String(Math.floor(opts.riskAcceptedAtMs / 1000)));
    }
  } finally {
    storeDb.close();
  }

  const authDb = openEncryptedDb(paths.authDb, deriveDbKey(master, 'auth'));
  try {
    await useDbAuthState(authDb); // creates the auth table
  } finally {
    authDb.close();
  }

  writeDefaultConfigs(paths);
  return master;
}
