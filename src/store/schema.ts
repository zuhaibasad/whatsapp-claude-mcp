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

/** Store schema version: single source of truth in core constants. */
export const STORE_SCHEMA_VERSION = SCHEMA_VERSION;

/** v1 -> v2: channel chat type, activity/unread columns, contacts table. Rebuilds chats (CHECK change). */
const UPGRADE_V2 = `
CREATE TABLE chats_v2 (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('group','direct','channel')),
  name TEXT,
  participant_count INTEGER,
  muted INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 1,
  last_message_at INTEGER,
  unread_count INTEGER,
  last_activity_at INTEGER
);
INSERT INTO chats_v2(id, type, name, participant_count, muted, archived, included, last_message_at, unread_count, last_activity_at)
  SELECT id, CASE WHEN id LIKE '%@newsletter' THEN 'channel' ELSE type END, name, participant_count, muted, archived,
         included, last_message_at, NULL, last_message_at FROM chats;
DROP TABLE chats;
ALTER TABLE chats_v2 RENAME TO chats;

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  phone_jid TEXT,
  lid TEXT,
  saved_name TEXT,
  push_name TEXT,
  verified_name TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone_jid);
CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts (lid);
`;

/** v2 -> v3: quoted reply copy and location/contact card payload (JSON). */
const UPGRADE_V3 = `
ALTER TABLE messages ADD COLUMN quoted_text TEXT;
ALTER TABLE messages ADD COLUMN quoted_sender_name TEXT;
ALTER TABLE messages ADD COLUMN extra TEXT;
`;

/** v3 -> v4: downloaded images (bytes live in the encrypted DB) and their local OCR text, searchable. */
const UPGRADE_V4 = `
CREATE TABLE IF NOT EXISTS media (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mimetype TEXT,
  file_length INTEGER,
  media_key TEXT,
  direct_path TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  bytes BLOB,
  size INTEGER,
  ocr_text TEXT,
  ocr_fields TEXT,
  ocr_confidence REAL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_media_status ON media (status, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
  ocr_text, content='media', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2"
);
CREATE TRIGGER IF NOT EXISTS media_ai AFTER INSERT ON media BEGIN
  INSERT INTO media_fts(rowid, ocr_text) VALUES (new.rowid, new.ocr_text);
END;
CREATE TRIGGER IF NOT EXISTS media_ad AFTER DELETE ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, ocr_text) VALUES ('delete', old.rowid, old.ocr_text);
END;
CREATE TRIGGER IF NOT EXISTS media_au AFTER UPDATE OF ocr_text ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, ocr_text) VALUES ('delete', old.rowid, old.ocr_text);
  INSERT INTO media_fts(rowid, ocr_text) VALUES (new.rowid, new.ocr_text);
END;
`;

/** Creates/updates the schema (v1..v4). Idempotent. */
export function migrate(db: Db): void {
  db.transaction(() => {
    db.exec(SCHEMA_V1);
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')").run();
    const cur = Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    if (cur > STORE_SCHEMA_VERSION) throw new Error(`store.db schema v${cur} is newer than supported v${STORE_SCHEMA_VERSION}`);
    if (cur < 2) {
      db.exec(UPGRADE_V2);
      db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    }
    if (cur < 3) {
      db.exec(UPGRADE_V3);
      db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    }
    if (cur < 4) {
      db.exec(UPGRADE_V4);
      db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
    }
  })();
}
