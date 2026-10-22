import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3-multiple-ciphers';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type makeWASocket from 'baileys';
import type { ChatMeta, RawMessage } from '../../../src/core/contracts.js';
import type { Contact } from '../../../src/core/types.js';
import { useDbAuthState } from '../../../src/daemon/wa/auth-state.js';
import { createWaClient } from '../../../src/daemon/wa/wa-client.js';

async function build() {
  const ev = new EventEmitter();
  const accessed: string[] = [];
  const target = {
    ev: { on: ev.on.bind(ev), off: ev.off.bind(ev), emit: ev.emit.bind(ev), removeAllListeners: ev.removeAllListeners.bind(ev) },
    user: { id: '111:7@s.whatsapp.net', lid: '999:7@lid', name: 'Me' },
    end: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
  const proxy = new Proxy(target, {
    get(t, prop, r) {
      if (typeof prop === 'string') accessed.push(prop);
      return Reflect.get(t, prop, r);
    },
  });
  const auth = await useDbAuthState(new Database(':memory:'));
  const client = createWaClient({
    auth,
    logger: pino({ level: 'silent' }),
    socketFactory: (() => proxy) as unknown as typeof makeWASocket,
    fetchVersion: async () => ({ version: [2, 3000, 1] }),
  });
  const seen = {
    chats: [] as ChatMeta[], contacts: [] as unknown[], lid: [] as { lid: string; phoneJid: string }[],
    activity: [] as unknown[], msgs: [] as RawMessage[],
  };
  client.on('chats', (c) => seen.chats.push(...c));
  client.on('contacts', (c) => seen.contacts.push(...(c as Partial<Contact>[])));
  client.on('lid-map', (m) => seen.lid.push(m));
  client.on('activity', (a) => seen.activity.push(a));
  client.on('messages', (m) => seen.msgs.push(...m));
  await client.connect();
  return { ev, seen, accessed, client };
}

describe('chat metadata from Baileys events', () => {
  it('emits activity, unread, channels, contacts and LID mappings, without write APIs', async () => {
    const { ev, seen, accessed } = await build();

    ev.emit('chats.upsert', [
      { id: '5@s.whatsapp.net', conversationTimestamp: { low: 1700000000, high: 0 }, unreadCount: 3 },
      { id: '6@lid', conversationTimestamp: 1700000100, unreadCount: -1 },
      { id: '120363@newsletter', name: 'My Channel', conversationTimestamp: 1700000200 },
      { id: 'status@broadcast', conversationTimestamp: 1 },
    ]);
    expect(seen.chats).toContainEqual({ id: '5@s.whatsapp.net', type: 'direct', name: null, lastActivityAt: 1700000000, unreadCount: 3 });
    expect(seen.chats).toContainEqual({ id: '6@lid', type: 'direct', name: null, lastActivityAt: 1700000100 });
    expect(seen.chats).toContainEqual({ id: '120363@newsletter', type: 'channel', name: 'My Channel', lastActivityAt: 1700000200 });
    expect(seen.chats.some((c) => c.id === 'status@broadcast')).toBe(false);

    ev.emit('contacts.upsert', [{ id: '6@lid', phoneNumber: '923001@s.whatsapp.net', name: 'Saved', notify: 'Pushy', verifiedName: 'Biz' }]);
    expect(seen.contacts).toContainEqual({
      id: '6@lid', phoneJid: '923001@s.whatsapp.net', lid: '6@lid', savedName: 'Saved', pushName: 'Pushy', verifiedName: 'Biz',
    });
    expect(seen.lid).toContainEqual({ lid: '6@lid', phoneJid: '923001@s.whatsapp.net' });

    ev.emit('lid-mapping.update', { lid: '7@lid', pn: '924@s.whatsapp.net' });
    expect(seen.lid).toContainEqual({ lid: '7@lid', phoneJid: '924@s.whatsapp.net' });

    ev.emit('messaging-history.set', {
      chats: [], contacts: [], messages: [], lidPnMappings: [{ lid: '8@lid', pn: '925@s.whatsapp.net' }],
    });
    expect(seen.lid).toContainEqual({ lid: '8@lid', phoneJid: '925@s.whatsapp.net' });

    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: '6@lid', remoteJidAlt: '926@s.whatsapp.net', id: 'A' }, pushName: 'Pushy', messageTimestamp: 1700000300, message: { conversation: 'secret text' } },
        { key: { remoteJid: 'g@g.us', participant: '9@lid', participantAlt: '927@s.whatsapp.net', id: 'B' }, pushName: 'Gee', messageTimestamp: 1700000400, message: { reactionMessage: {} } },
        { key: { remoteJid: '120363@newsletter', id: 'C' }, messageTimestamp: 1700000500, message: { conversation: 'news' } },
        { key: { remoteJid: 'status@broadcast', id: 'S' }, messageTimestamp: 5, message: { conversation: 'st' } },
      ],
    });
    expect(seen.activity).toEqual([
      { chatId: '6@lid', ts: 1700000300, pushName: 'Pushy', senderId: '926@s.whatsapp.net' },
      { chatId: 'g@g.us', ts: 1700000400, pushName: 'Gee', senderId: '927@s.whatsapp.net' },
      { chatId: '120363@newsletter', ts: 1700000500, pushName: null, senderId: '120363@newsletter' },
    ]);
    expect(JSON.stringify(seen.activity)).not.toContain('secret');
    expect(seen.lid).toContainEqual({ lid: '6@lid', phoneJid: '926@s.whatsapp.net' });
    expect(seen.lid).toContainEqual({ lid: '9@lid', phoneJid: '927@s.whatsapp.net' });
    expect(seen.msgs.map((m) => m.id)).toEqual(['A', 'C']); // channel messages normalize like DMs
    expect(seen.msgs[1]).toMatchObject({ chatId: '120363@newsletter', senderId: '120363@newsletter' });

    expect(new Set(accessed)).toEqual(new Set(['ev']));
  });
});
