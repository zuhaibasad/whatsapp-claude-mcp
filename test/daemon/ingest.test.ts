import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/contracts.js';
import { createLogger } from '../../src/core/logger.js';
import type { RawMessage } from '../../src/core/contracts.js';
import { Ingestor } from '../../src/daemon/ingest.js';
import { SqliteStore } from '../../src/store/index.js';

const G1 = '111@g.us';
const G2 = '222@g.us';
const ME = { id: '999@s.whatsapp.net', lid: '888@lid', names: ['Zuhaib'] };

let n = 0;
function raw(o: Partial<RawMessage> = {}): RawMessage {
  n++;
  return {
    id: `m${n}`, chatId: G1, senderId: 'a@s.whatsapp.net', senderName: null, ts: 1000 + n, text: 'hello',
    quotedId: null, quotedSenderId: null, mentions: [], isFromMe: false, hasMedia: false, mediaType: null, ...o,
  };
}

let config: Config;
let store: SqliteStore;
let ing: Ingestor;
beforeEach(() => {
  config = {
    retentionDays: 30, timezone: 'UTC', includeGroups: true, includeDirectChats: false, includeChannels: false,
    allowlist: [], denylist: [], myNames: ['Zuhaib'], maxTextChars: 2000, logLevel: 'error',
  };
  store = new SqliteStore(new Database(':memory:'));
  store.migrate();
  ing = new Ingestor(store, () => config, () => ME, createLogger({ level: 'silent' }));
});

describe('Ingestor', () => {
  it('does not store messages from excluded chats', () => {
    config.denylist = [G2];
    ing.onMessages([raw({ chatId: G1 }), raw({ chatId: G2 }), raw({ chatId: '5@s.whatsapp.net' })]);
    expect(store.counts().messages).toBe(1);
    expect(store.getChat(G2)?.included).toBe(false);
    expect(store.getChat('5@s.whatsapp.net')?.included).toBe(false);
    expect(ing.counters).toMatchObject({ ingested: 1, skipped_excluded: 2 });
  });

  it('calls onExcluded instead of dropping silently, and not for included chats', () => {
    config.denylist = [G2];
    const seen: string[] = [];
    ing.onExcluded = (m) => void seen.push(m.chatId);
    ing.onMessages([raw({ chatId: G1 }), raw({ chatId: G2 })]);
    expect(seen).toEqual([G2]);
    expect(store.counts().messages).toBe(1);
  });

  it('applies mention detection', () => {
    ing.onMessages([
      raw({ id: 'a', mentions: [ME.lid] }),
      raw({ id: 'b', text: 'ping Zuhaib please' }),
      raw({ id: 'c', quotedSenderId: ME.id }),
      raw({ id: 'd' }),
    ]);
    expect(store.getMessage(G1, 'a')?.mentionReason).toBe('at_mention');
    expect(store.getMessage(G1, 'b')?.mentionReason).toBe('name');
    expect(store.getMessage(G1, 'c')?.mentionReason).toBe('reply');
    expect(store.getMessage(G1, 'd')?.mentionReason).toBeNull();
  });

  it('truncates text and counts duplicates', () => {
    config.maxTextChars = 10;
    const m = raw({ id: 'long', text: 'x'.repeat(50) });
    ing.onMessages([m, m]);
    expect(store.getMessage(G1, 'long')?.text).toBe('x'.repeat(10));
    expect(ing.counters.duplicates).toBe(1);
  });

  it('fills sender names from contacts', () => {
    ing.onContacts([{ id: 'a@s.whatsapp.net', savedName: 'Ali' }]);
    ing.onMessages([raw({ id: 'x' })]);
    expect(store.getMessage(G1, 'x')?.senderName).toBe('Ali');
  });

  it('applies edits and deletes', () => {
    ing.onMessages([raw({ id: 'e1', text: 'old' })]);
    ing.onEdit({ chatId: G1, messageId: 'e1', newText: 'new' });
    expect(store.getMessage(G1, 'e1')).toMatchObject({ text: 'new', edited: true });
    ing.onDelete({ chatId: G1, messageId: 'e1' });
    expect(store.getMessage(G1, 'e1')?.deleted).toBe(true);
    ing.onEdit({ chatId: G1, messageId: 'unknown', newText: 'z' });
  });

  it('stores groups with participants and keeps names', () => {
    ing.onGroups([{
      id: G1, subject: 'ERP Support',
      participants: [
        { id: 'a@s.whatsapp.net', displayName: 'Ali', isAdmin: true },
        { id: 'b@s.whatsapp.net', displayName: null, isAdmin: false },
      ],
    }]);
    expect(store.getChat(G1)).toMatchObject({ name: 'ERP Support', type: 'group', participantCount: 2, included: true });
    expect(store.getParticipants(G1)).toHaveLength(2);
    ing.onChats([{ id: G1, type: 'group', name: null }]);
    expect(store.getChat(G1)?.name).toBe('ERP Support');
  });

  it('names direct chats from contacts when null', () => {
    const d = '7@s.whatsapp.net';
    ing.onChats([{ id: d, type: 'direct', name: null }]);
    expect(store.getChat(d)?.name).toBeNull();
    ing.onContacts([{ id: d, savedName: 'Sara' }]);
    expect(store.getChat(d)?.name).toBe('Sara');
  });

  it('config change flips inclusion', () => {
    ing.onMessages([raw({ chatId: G1 })]);
    config.denylist = [G1];
    expect(ing.recomputeIncluded()).toBe(1);
    expect(store.getChat(G1)?.included).toBe(false);
    ing.onMessages([raw({ chatId: G1 })]);
    expect(store.counts().messages).toBe(1);
    config.denylist = [];
    ing.recomputeIncluded();
    expect(store.getChat(G1)?.included).toBe(true);
    ing.onMessages([raw({ chatId: G1 })]);
    expect(store.counts().messages).toBe(2);
  });
});
