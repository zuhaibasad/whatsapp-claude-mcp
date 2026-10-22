import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { SCHEMA_V1, SqliteStore } from '../../src/store/index.js';

const msg = (o: Record<string, unknown>) => ({
  id: 'm', chatId: '1@g.us', senderId: 'a', senderName: null, ts: 100, text: 't', quotedId: null, quotedSenderId: null,
  mentions: [], mentionReason: null, isFromMe: false, hasMedia: false, mediaType: null, ...o,
});

describe('schema v2 -> v3', () => {
  it('adds quoted_text, quoted_sender_name and extra in place, keeping data', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_V1);
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run();
    const s = new SqliteStore(db);
    s.migrate();
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    db.exec('ALTER TABLE messages DROP COLUMN quoted_text; ALTER TABLE messages DROP COLUMN quoted_sender_name; ALTER TABLE messages DROP COLUMN extra;');
    db.prepare("INSERT INTO messages(id, chat_id, sender_id, ts, text) VALUES ('old','1@g.us','a',50,'legacy')").run();
    s.migrate();
    s.migrate();
    expect(s.getMeta('schema_version')).toBe('3');
    expect(s.getMessage('1@g.us', 'old')).toMatchObject({ text: 'legacy', quotedText: null, quotedSenderName: null, extra: null });
    s.insertMessage(msg({ id: 'n', quotedText: 'q', quotedSenderName: 'Q', extra: { location: { lat: 1, lng: 2 } } }));
    expect(s.getMessage('1@g.us', 'n')).toMatchObject({ quotedText: 'q', quotedSenderName: 'Q', extra: { location: { lat: 1, lng: 2 } } });
    s.markDeleted('1@g.us', 'n');
    expect(s.getMessage('1@g.us', 'n')).toMatchObject({ quotedText: null, extra: null });
  });

  it('getMessagesBefore returns the n latest earlier messages, oldest first, skipping deleted', () => {
    const s = new SqliteStore(new Database(':memory:'));
    s.migrate();
    for (let i = 1; i <= 6; i++) s.insertMessage(msg({ id: `m${i}`, ts: i * 10 }));
    s.markDeleted('1@g.us', 'm4');
    expect(s.getMessagesBefore('1@g.us', 60, 3).map((m) => m.id)).toEqual(['m2', 'm3', 'm5']);
    expect(s.getMessagesBefore('1@g.us', 10, 3)).toEqual([]);
  });
});
