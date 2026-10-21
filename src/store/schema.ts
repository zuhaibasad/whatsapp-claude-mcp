import { SCHEMA_VERSION } from '../core/constants.js';
import type { Db } from '../core/contracts.js';

/** Schema v1 (docs/PLAN.md section 5). messages.mention_reason replaces the plan's mentions_me INT. */
export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  lid TEXT,
  push_name TEXT,
  link_status TEXT NOT NULL DEFAULT 'unlinked',
  linked_at INTEGER,
  last_connected_at INTEGER,
  last_message_at INTEGER
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('group','direct')),
  name TEXT,
  participant_count INTEGER,
  muted INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 1,
  last_message_at INTEGER
);

CREATE TABLE IF NOT EXISTS participants (
  chat_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  display_name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  ts INTEGER NOT NULL,
  text TEXT,
  quoted_id TEXT,
  quoted_sender_id TEXT,
  mentions TEXT NOT NULL DEFAULT '[]',
  mention_reason TEXT,
  is_from_me INTEGER NOT NULL DEFAULT 0,
  has_media INTEGER NOT NULL DEFAULT 0,
  media_type TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS idx_messages_mention_ts ON messages (mention_reason, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS unread_state (
  chat_id TEXT PRIMARY KEY,
  reviewed_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT,
  priority TEXT NOT NULL,
  summary TEXT NOT NULL,
  requester TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (chat_id, message_id, category)
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items (status);
`;

/** Creates/updates the schema. Idempotent. */
export function migrate(db: Db): void {
  db.transaction(() => {
    db.exec(SCHEMA_V1);
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  })();
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const v = Number(row?.value ?? 0);
  if (v > SCHEMA_VERSION) throw new Error(`store.db schema v${v} is newer than supported v${SCHEMA_VERSION}`);
}
