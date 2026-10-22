import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageInput } from '../../src/core/types.js';
import { SqliteStore } from '../../src/store/index.js';

const G1 = '111@g.us';
const G2 = '222@g.us';
let n = 0;
function msg(o: Partial<MessageInput> = {}): MessageInput {
  n++;
  return {
    id: `m${n}`, chatId: G1, senderId: 'a@s.whatsapp.net', senderName: 'Ali', ts: 1000 + n, text: 'hello world',
    quotedId: null, quotedSenderId: null, mentions: [], mentionReason: null, isFromMe: false,
    hasMedia: false, mediaType: null, ...o,
  };
}

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(new Database(':memory:'));
  store.migrate();
});

describe('store', () => {
  it('migrate is idempotent', () => {
    store.migrate();
    store.migrate();
    expect(store.getMeta('schema_version')).toBe('2');
  });

  it('dedupes inserts and bumps last_message_at', () => {
    store.upsertAccount({ id: 'me@s.whatsapp.net' });
    const m = msg({ ts: 500 });
    expect(store.insertMessage(m)).toBe(true);
    expect(store.insertMessage(m)).toBe(false);
    expect(store.counts().messages).toBe(1);
    expect(store.getChat(G1)).toMatchObject({ type: 'group', included: true, lastMessageAt: 500 });
    store.insertMessage(msg({ ts: 400 }));
    expect(store.getChat(G1)?.lastMessageAt).toBe(500);
    expect(store.getAccount()?.lastMessageAt).toBe(500);
    store.insertMessage(msg({ chatId: 'x@s.whatsapp.net' }));
    expect(store.getChat('x@s.whatsapp.net')?.type).toBe('direct');
  });

  it('edit and delete keep FTS right', () => {
    const m = msg({ text: 'invoice pending' });
    store.insertMessage(m);
    expect(store.applyEdit(G1, m.id, 'receipt attached')).toBe(true);
    expect(store.getMessage(G1, m.id)).toMatchObject({ edited: true, text: 'receipt attached' });
    expect(store.searchMessages('invoice', { limit: 5 })).toHaveLength(0);
    expect(store.searchMessages('receipt', { limit: 5 })).toHaveLength(1);
    expect(store.markDeleted(G1, m.id)).toBe(true);
    expect(store.getMessage(G1, m.id)).toMatchObject({ deleted: true, text: null });
    expect(store.searchMessages('receipt', { limit: 5 })).toHaveLength(0);
    expect(store.applyEdit(G1, 'nope', 'x')).toBe(false);
  });

  it('getNewMessages uses per-chat last_review, limit, and hides excluded chats', () => {
    store.insertMessage(msg({ chatId: G1, ts: 10 }));
    store.insertMessage(msg({ chatId: G1, ts: 20 }));
    store.insertMessage(msg({ chatId: G2, ts: 30 }));
    store.insertMessage(msg({ chatId: G2, ts: 40, isFromMe: true }));
    let r = store.getNewMessages({ since: 'last_review', limit: 100 });
    expect(r.truncated).toBe(false);
    expect(r.chats.map((c) => c.chat.id)).toEqual([G2, G1]);
    expect(r.chats[0]?.messages.map((m) => m.ts)).toEqual([30, 40]);
    store.setReviewed([G1], 10);
    r = store.getNewMessages({ since: 'last_review', limit: 100 });
    expect(r.chats.find((c) => c.chat.id === G1)?.messages.map((m) => m.ts)).toEqual([20]);
    r = store.getNewMessages({ since: 'last_review', limit: 2 });
    expect(r.truncated).toBe(true);
    expect(r.chats.flatMap((c) => c.messages)).toHaveLength(2);
    store.setChatIncluded(G2, false);
    r = store.getNewMessages({ since: 0, limit: 100 });
    expect(r.chats.map((c) => c.chat.id)).toEqual([G1]);
  });

  it('setReviewed is monotonic and counts rows', () => {
    store.insertMessage(msg({ chatId: G1 }));
    store.insertMessage(msg({ chatId: G2 }));
    expect(store.setReviewed(undefined, 100)).toBe(2);
    store.setReviewed([G1], 50);
    expect(store.getReviewedUntil(G1)).toBe(100);
    store.setReviewed([G1], 150);
    expect(store.getReviewedUntil(G1)).toBe(150);
    expect(store.getReviewedUntil('unknown')).toBe(0);
  });

  it('search handles tricky input, Roman Urdu, and Urdu script', () => {
    store.insertMessage(msg({ text: 'payment kal tak chahiye' }));
    store.insertMessage(msg({ text: 'ادائیگی کل تک چاہیے' }));
    for (const q of ['foo" OR (', '*', 'NEAR', '', '   ', '"', 'a AND', 'NOT', '(((', 'x:y']) {
      expect(() => store.searchMessages(q, { limit: 5 })).not.toThrow();
    }
    const hits = store.searchMessages('payment kal', { limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('[payment]');
    expect(hits[0]?.chatName).toBeNull();
    expect(store.searchMessages('ادائیگی', { limit: 5 })).toHaveLength(1);
    expect(store.searchMessages('payment', { limit: 5, since: 99999 })).toHaveLength(0);
  });

  it('getMentions', () => {
    store.insertMessage(msg({ ts: 10, mentionReason: 'at_mention' }));
    store.insertMessage(msg({ ts: 20, mentionReason: 'reply' }));
    store.insertMessage(msg({ ts: 30 }));
    const r = store.getMentions({ since: 'last_review', limit: 10 });
    expect(r.map((m) => m.mentionReason)).toEqual(['at_mention', 'reply']);
    store.setReviewed([G1], 10);
    expect(store.getMentions({ since: 'last_review', limit: 10 })).toHaveLength(1);
  });

  it('listChats computes unreviewed (not from me)', () => {
    store.insertMessage(msg({ ts: 10 }));
    store.insertMessage(msg({ ts: 20 }));
    store.insertMessage(msg({ ts: 30, isFromMe: true }));
    expect(store.listChats()[0]?.unreviewed).toBe(2);
    store.setReviewed([G1], 10);
    expect(store.listChats({ includedOnly: true, type: 'group' })[0]?.unreviewed).toBe(1);
    expect(store.listChats({ type: 'direct' })).toHaveLength(0);
  });

  it('purge removes messages and FTS rows', () => {
    store.insertMessage(msg({ ts: 10, text: 'oldword' }));
    store.insertMessage(msg({ ts: 100, text: 'newword' }));
    expect(store.purgeOlderThan(50)).toBe(1);
    expect(store.searchMessages('oldword', { limit: 5 })).toHaveLength(0);
    expect(store.searchMessages('newword', { limit: 5 })).toHaveLength(1);
    expect(store.counts().messages).toBe(1);
  });

  it('items: save, dup, list, update, sourcePurged', () => {
    store.upsertChat({ id: G1, type: 'group', name: 'ERP Support' });
    const m = msg({ ts: 10 });
    store.insertMessage(m);
    const item = { chatId: G1, messageId: m.id, category: 'request' as const, department: 'Finance', priority: 'high' as const, summary: 's', requester: 'Ali' };
    const r1 = store.saveItems([item]);
    expect(r1).toMatchObject({ saved: 1, duplicates: 0 });
    const r2 = store.saveItems([item, { ...item, category: 'fyi' }]);
    expect(r2).toMatchObject({ saved: 1, duplicates: 1 });
    expect(r2.ids[0]).toBe(r1.ids[0]);
    let list = store.listItems();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ chatName: 'ERP Support', sourcePurged: false, status: 'open' });
    expect(store.updateItem(r1.ids[0] as number, 'done')?.status).toBe('done');
    expect(store.updateItem(9999, 'done')).toBeNull();
    expect(store.listItems({ status: 'open' })).toHaveLength(1);
    expect(store.counts().openItems).toBe(1);
    store.purgeOlderThan(100);
    list = store.listItems({ limit: 1 });
    expect(list).toHaveLength(1);
    expect(list[0]?.sourcePurged).toBe(true);
  });

  it('chats, participants, account, meta, counts', () => {
    store.upsertChat({ id: G1, type: 'group', name: 'A', included: false });
    store.upsertChat({ id: G1, type: 'group', muted: true });
    expect(store.getChat(G1)).toMatchObject({ name: 'A', muted: true, included: false });
    store.replaceParticipants(G1, [{ contactId: 'p1', displayName: 'P', isAdmin: true }]);
    expect(store.getParticipants(G1)).toEqual([{ chatId: G1, contactId: 'p1', displayName: 'P', isAdmin: true }]);
    expect(store.getChat(G1)?.participantCount).toBe(1);
    store.upsertAccount({ id: 'me', pushName: 'Me' });
    store.setLinkStatus('linked', 77);
    expect(store.getAccount()).toMatchObject({ pushName: 'Me', linkStatus: 'linked', linkedAt: 77 });
    store.setMeta('k', 'v');
    store.setMeta('k', 'v2');
    expect(store.getMeta('k')).toBe('v2');
    expect(store.counts()).toMatchObject({ chatsTotal: 1, chatsIncluded: 0 });
  });

  it('getMessages ranges and order', () => {
    for (const ts of [1, 2, 3, 4]) store.insertMessage(msg({ ts }));
    expect(store.getMessages({ since: 2, until: 3, limit: 10 }).map((m) => m.ts)).toEqual([2, 3]);
    expect(store.getMessages({ limit: 2, order: 'desc' }).map((m) => m.ts)).toEqual([4, 3]);
  });
});
