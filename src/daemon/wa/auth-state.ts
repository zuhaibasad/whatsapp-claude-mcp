// Baileys AuthenticationState backed by an (encrypted) SQLite table instead of plaintext files.
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';
import type { Db } from '../../core/contracts.js';

export interface DbAuthState {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** Deletes every stored row (creds and keys) and resets the in-memory creds. Used by unlink. */
  clear(): void;
  /** True when the stored creds belong to a linked account (creds.me is set). */
  hasCreds(): boolean;
}

const CREDS_KEY = 'creds';

export async function useDbAuthState(db: Db): Promise<DbAuthState> {
  db.exec('CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  const selectStmt = db.prepare('SELECT value FROM auth_kv WHERE key = ?');
  const upsertStmt = db.prepare(
    'INSERT INTO auth_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const deleteStmt = db.prepare('DELETE FROM auth_kv WHERE key = ?');

  const read = (key: string): unknown => {
    const row = selectStmt.get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value, BufferJSON.reviver) as unknown;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: unknown): void => {
    upsertStmt.run(key, JSON.stringify(value, BufferJSON.replacer));
  };

  const stored = read(CREDS_KEY) as AuthenticationCreds | null;
  const state: AuthenticationState = {
    creds: stored ?? initAuthCreds(),
    keys: {
      get: async (type, ids) => {
        type V = SignalDataTypeMap[typeof type];
        const data: { [id: string]: V } = {};
        for (const id of ids) {
          let value = read(`${type}-${id}`) as V | null;
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as proto.Message.IAppStateSyncKeyData,
            ) as unknown as V;
          }
          data[id] = value as V;
        }
        return data;
      },
      set: async (data: SignalDataSet) => {
        const apply = db.transaction(() => {
          for (const category of Object.keys(data)) {
            const entries = data[category as keyof SignalDataSet] as Record<string, unknown> | undefined;
            if (!entries) continue;
            for (const id of Object.keys(entries)) {
              const value = entries[id];
              const key = `${category}-${id}`;
              if (value === null || value === undefined) deleteStmt.run(key);
              else write(key, value);
            }
          }
        });
        apply();
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      write(CREDS_KEY, state.creds);
    },
    clear: () => {
      db.exec('DELETE FROM auth_kv');
      state.creds = initAuthCreds();
    },
    hasCreds: () => {
      const creds = read(CREDS_KEY) as { me?: unknown } | null;
      return !!creds && !!creds.me;
    },
  };
}
