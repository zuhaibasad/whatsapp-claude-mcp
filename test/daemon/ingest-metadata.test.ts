import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config, RawMessage } from '../../src/core/contracts.js';
import { createLogger } from '../../src/core/logger.js';
import { Ingestor } from '../../src/daemon/ingest.js';
import { SqliteStore } from '../../src/store/index.js';

let config: Config;
let store: SqliteStore;
let ing: Ingestor;
beforeEach(() => {
  config = {
    retentionDays: 30, timezone: 'UTC', includeGroups: true, includeDirectChats: false, includeChannels: false,
    allowlist: [], denylist: [], myNames: [], maxTextChars: 2000, logLevel: 'error', mediaDownload: true, mediaOcr: true, mediaMaxMb: 500,
  };
  store = new SqliteStore(new Database(':memory:'));
  store.migrate();
  ing = new Ingestor(store, () => config, () => null, createLogger({ level: 'silent' }));
});

const msg = (chatId: string): RawMessage => ({
  id: 'm1', chatId, senderId: chatId, senderName: null, ts: 50, text: 'hi', quotedId: null, quotedSenderId: null,
  mentions: [], isFromMe: false, hasMedia: false, mediaType: null,
});

describe('Ingestor metadata', () => {
  it('records activity and push names for excluded chats without storing text', () => {
    ing.onActivity({ chatId: '5@s.whatsapp.net', ts: 100, pushName: 'Ali', senderId: '5@s.whatsapp.net' });
    ing.onActivity({ chatId: '5@s.whatsapp.net', ts: 90, pushName: null, senderId: '5@s.whatsapp.net' });
    ing.onMessages([msg('5@s.whatsapp.net')]);
    expect(store.getChat('5@s.whatsapp.net')).toMatchObject({ included: false, lastActivityAt: 100, lastMessageAt: null });
    expect(store.counts().messages).toBe(0);
    expect(store.getContact('5@s.whatsapp.net')?.pushName).toBe('Ali');
  });

  it('a new chat created from activity gets included from the config filter', () => {
    ing.onActivity({ chatId: 'g@g.us', ts: 10, pushName: null, senderId: 'x@s.whatsapp.net' });
    config.denylist = ['h@g.us'];
    ing.onActivity({ chatId: 'h@g.us', ts: 10, pushName: null, senderId: 'x@s.whatsapp.net' });
    expect(store.getChat('g@g.us')?.included).toBe(true);
    expect(store.getChat('h@g.us')?.included).toBe(false);
  });

  it('chat meta stores activity + unread; channels follow includeChannels', () => {
    ing.onChats([
      { id: '1@newsletter', type: 'channel', name: 'News', lastActivityAt: 70, unreadCount: 2 },
      { id: '7@s.whatsapp.net', type: 'direct', name: null, lastActivityAt: 80, unreadCount: 0 },
    ]);
    expect(store.getChat('1@newsletter')).toMatchObject({ type: 'channel', included: false, lastActivityAt: 70, unreadCount: 2 });
    expect(store.getChat('7@s.whatsapp.net')).toMatchObject({ lastActivityAt: 80, unreadCount: 0 });
    config.includeChannels = true;
    expect(ing.recomputeIncluded()).toBe(1);
    expect(store.getChat('1@newsletter')?.included).toBe(true);
    ing.onMessages([msg('1@newsletter')]);
    expect(store.counts().messages).toBe(1);
  });

  it('persists contacts, LID links and group participant names; names chats via LID', () => {
    ing.onChats([{ id: '9@lid', type: 'direct', name: null }]);
    ing.onContacts([{ id: '9@lid', lid: '9@lid', phoneJid: '92300@s.whatsapp.net', savedName: 'Zed' }]);
    expect(store.getChat('9@lid')?.name).toBe('Zed');
    ing.onLidMap({ lid: '10@lid', phoneJid: '92301@s.whatsapp.net' });
    expect(store.getContact('10@lid')?.phoneJid).toBe('92301@s.whatsapp.net');
    ing.onGroups([{ id: 'g@g.us', subject: 'G', participants: [{ id: '11@s.whatsapp.net', displayName: 'Pat', isAdmin: false }] }]);
    expect(store.getContact('11@s.whatsapp.net')?.pushName).toBe('Pat');
  });
});
