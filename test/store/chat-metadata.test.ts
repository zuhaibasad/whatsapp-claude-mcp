import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_V1, SqliteStore } from '../../src/store/index.js';

const NL = '120363@newsletter';

describe('schema v1 -> v2', () => {
  function v1(): Database.Database {
    const db = new Database(':memory:');
    db.exec(SCHEMA_V1);
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run();
    const ins = db.prepare('INSERT INTO chats(id, type, name, included, last_message_at) VALUES (?,?,?,?,?)');
    ins.run('1@g.us', 'group', 'ERP', 1, 500);
    ins.run('2@s.whatsapp.net', 'direct', 'Ali', 0, 700);
    ins.run(NL, 'direct', 'Some Channel', 0, null);
    db.prepare("INSERT INTO messages(id, chat_id, sender_id, ts, text) VALUES ('m1','1@g.us','a',500,'hello')").run();
    return db;
  }

  it('keeps data, retypes newsletters, adds columns and contacts, and is idempotent', () => {
    const db = v1();
    const store = new SqliteStore(db);
    store.migrate();
    store.migrate();
    expect(store.getMeta('schema_version')).toBe('2');
    expect(store.getChat(NL)).toMatchObject({ type: 'channel', name: 'Some Channel', included: false });
    expect(store.getChat('1@g.us')).toMatchObject({ type: 'group', name: 'ERP', included: true, lastMessageAt: 500, lastActivityAt: 500, unreadCount: null });
    expect(store.getChat('2@s.whatsapp.net')).toMatchObject({ type: 'direct', included: false, lastActivityAt: 700 });
    expect(store.counts().messages).toBe(1);
    expect(store.searchMessages('hello', { limit: 5 })).toHaveLength(1);
    expect(() => db.prepare("INSERT INTO chats(id, type) VALUES ('x','channel')").run()).not.toThrow();
    expect(() => db.prepare("INSERT INTO chats(id, type) VALUES ('y','bogus')").run()).toThrow();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='contacts'").all();
    expect(idx.length).toBeGreaterThanOrEqual(2);
  });
});

describe('chat activity and contacts', () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = new SqliteStore(new Database(':memory:'));
    store.migrate();
  });

  it('touchChatActivity on an excluded chat stores a timestamp but no message', () => {
    store.touchChatActivity('5@s.whatsapp.net', 100, 3, false);
    store.touchChatActivity('5@s.whatsapp.net', 50);
    expect(store.getChat('5@s.whatsapp.net')).toMatchObject({
      type: 'direct', included: false, lastActivityAt: 100, unreadCount: 3, lastMessageAt: null,
    });
    expect(store.counts().messages).toBe(0);
    store.touchChatActivity(NL, 10);
    expect(store.getChat(NL)?.type).toBe('channel');
    store.touchChatActivity('7@g.us', 10, undefined, true);
    expect(store.getChat('7@g.us')?.included).toBe(true);
    store.touchChatActivity('8@g.us', 10);
    expect(store.getChat('8@g.us')?.included).toBe(false);
  });

  it('insertMessage also bumps activity; listChats sorts by the later of the two', () => {
    store.touchChatActivity('a@g.us', 900);
    store.touchChatActivity('b@g.us', 100);
    store.insertMessage({
      id: 'm', chatId: 'b@g.us', senderId: 'x', senderName: null, ts: 1000, text: 't', quotedId: null, quotedSenderId: null,
      mentions: [], mentionReason: null, isFromMe: false, hasMedia: false, mediaType: null,
    });
    expect(store.listChats().map((c) => c.id)).toEqual(['b@g.us', 'a@g.us']);
    expect(store.getChat('b@g.us')?.lastActivityAt).toBe(1000);
  });

  it('upsertContact merges and a null never overwrites', () => {
    store.upsertContact({ id: '5@s.whatsapp.net', savedName: 'Ali', pushName: 'ali!' });
    store.upsertContact({ id: '5@s.whatsapp.net', savedName: null, pushName: 'Ali K', verifiedName: undefined });
    expect(store.getContact('5@s.whatsapp.net')).toMatchObject({
      id: '5@s.whatsapp.net', phoneJid: '5@s.whatsapp.net', savedName: 'Ali', pushName: 'Ali K', verifiedName: null,
    });
  });

  it('linkLid works in both directions and merges separate rows', () => {
    store.upsertContact({ id: '9@lid', pushName: 'Zed' });
    store.upsertContact({ id: '5@s.whatsapp.net', savedName: 'Ali' });
    store.linkLid('9@lid', '5@s.whatsapp.net');
    const viaLid = store.getContact('9@lid');
    const viaPhone = store.getContact('5@s.whatsapp.net');
    expect(viaLid).toEqual(viaPhone);
    expect(viaLid).toMatchObject({ lid: '9@lid', phoneJid: '5@s.whatsapp.net', savedName: 'Ali', pushName: 'Zed' });
    expect(store.getContact('nobody')).toBeNull();
  });
});
