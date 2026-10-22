import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3-multiple-ciphers';
import pino from 'pino';
import { proto } from 'baileys';
import type makeWASocket from 'baileys';
import { createWaClient, READ_ONLY_SOCKET_CONFIG, mapDisconnectReason } from '../../../src/daemon/wa/wa-client.js';
import { useDbAuthState } from '../../../src/daemon/wa/auth-state.js';
import type { ConnectionState, GroupMeta, ChatMeta, RawMessage } from '../../../src/core/contracts.js';

const DENY = [
  'sendMessage', 'relayMessage', 'sendReceipt', 'sendReceipts', 'readMessages', 'sendPresenceUpdate',
  'presenceSubscribe', 'chatModify', 'star', 'groupCreate', 'groupUpdateSubject', 'groupUpdateDescription',
  'groupParticipantsUpdate', 'groupLeave', 'groupInviteCode', 'groupAcceptInvite', 'groupRevokeInvite',
  'groupToggleEphemeral', 'groupSettingUpdate', 'groupJoinApprovalMode', 'groupMemberAddMode',
  'updateProfileName', 'updateProfileStatus', 'updateProfilePicture', 'removeProfilePicture', 'updateBlockStatus',
  'updateLastSeenPrivacy', 'addOrEditContact', 'removeContact', 'addLabel', 'removeLabel', 'newsletterCreate',
  'rejectCall', 'offerCall', 'appPatch', 'resyncAppState', 'downloadMediaMessage', 'fetchMessageHistory',
  'requestPlaceholderResend', 'sendWAMBuffer',
];

function setup(userOverride?: object) {
  const ev = new EventEmitter();
  const accessed: string[] = [];
  const target = {
    ev: { on: ev.on.bind(ev), off: ev.off.bind(ev), emit: ev.emit.bind(ev), removeAllListeners: ev.removeAllListeners.bind(ev) },
    user: userOverride ?? { id: '111:7@s.whatsapp.net', lid: '999:7@lid', name: 'Me' },
    end: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    groupFetchAllParticipating: vi.fn(async () => ({
      'g1@g.us': { id: 'g1@g.us', subject: 'ERP', participants: [{ id: '5@lid', phoneNumber: '5@s.whatsapp.net', name: 'Ali', admin: 'admin' }] },
    })),
    groupMetadata: vi.fn(async (id: string) => ({ id, subject: 'Renamed', participants: [{ id: '6@s.whatsapp.net', notify: 'Bob' }] })),
  };
  const proxy = new Proxy(target, {
    get(t, prop, r) {
      if (typeof prop === 'string') accessed.push(prop);
      return Reflect.get(t, prop, r);
    },
  });
  const config: Record<string, unknown>[] = [];
  const factory = ((cfg: Record<string, unknown>) => {
    config.push(cfg);
    return proxy;
  }) as unknown as typeof makeWASocket;
  return { ev, accessed, target, factory, config };
}

async function build(userOverride?: object) {
  const s = setup(userOverride);
  const db = new Database(':memory:');
  const auth = await useDbAuthState(db);
  const client = createWaClient({
    auth,
    logger: pino({ level: 'silent' }),
    socketFactory: s.factory,
    fetchVersion: async () => ({ version: [2, 3000, 1] }),
  });
  const seen = {
    conn: [] as ConnectionState[], msgs: [] as RawMessage[], edits: [] as unknown[], dels: [] as unknown[],
    chats: [] as ChatMeta[], groups: [] as GroupMeta[], contacts: [] as unknown[],
  };
  client.on('connection', (c) => seen.conn.push(c));
  client.on('messages', (m) => seen.msgs.push(...m));
  client.on('edit', (e) => seen.edits.push(e));
  client.on('delete', (e) => seen.dels.push(e));
  client.on('chats', (c) => seen.chats.push(...c));
  client.on('groups', (g) => seen.groups.push(...g));
  client.on('contacts', (c) => seen.contacts.push(...c));
  return { ...s, client, seen, auth, db };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('READ_ONLY_SOCKET_CONFIG', () => {
  it('has the mandatory flags', () => {
    expect(READ_ONLY_SOCKET_CONFIG).toMatchObject({
      markOnlineOnConnect: false, syncFullHistory: false, fireInitQueries: true,
      emitOwnEvents: false, generateHighQualityLinkPreview: false,
    });
    const f = READ_ONLY_SOCKET_CONFIG.shouldSyncHistoryMessage;
    expect(f({ syncType: proto.HistorySync.HistorySyncType.FULL })).toBe(false);
    expect(f({ syncType: proto.HistorySync.HistorySyncType.RECENT })).toBe(true);
  });
});

describe('createWaClient', () => {
  it('passes a read-only config to the socket factory', async () => {
    const { client, config, auth } = await build();
    await client.connect();
    expect(config).toHaveLength(1);
    expect(config[0]).toMatchObject({ markOnlineOnConnect: false, syncFullHistory: false, version: [2, 3000, 1] });
    expect(config[0]!.auth).toBe(auth.state);
    expect(Array.isArray(config[0]!.browser)).toBe(true);
    expect(await (config[0]!.getMessage as () => Promise<unknown>)()).toBeUndefined();
  });

  it('drives a full session without touching any write API', async () => {
    const { client, ev, seen, accessed, target } = await build();
    await client.connect();

    ev.emit('connection.update', { connection: 'connecting' });
    ev.emit('connection.update', { qr: 'QRDATA' });
    ev.emit('connection.update', { connection: 'open' });
    await tick();
    expect(seen.conn.map((c) => c.state)).toEqual(['connecting', 'qr', 'open']);
    expect(seen.conn[2]).toEqual({ state: 'open', me: { id: '111@s.whatsapp.net', lid: '999@lid', pushName: 'Me' } });
    expect(target.groupFetchAllParticipating).toHaveBeenCalledTimes(1);
    expect(seen.groups[0]).toEqual({ id: 'g1@g.us', subject: 'ERP', participants: [{ id: '5@s.whatsapp.net', displayName: 'Ali', isAdmin: true }] });

    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: 'g1@g.us', id: 'M1', participant: '5@s.whatsapp.net' }, messageTimestamp: 10, message: { conversation: 'hello' } },
        { key: { remoteJid: 'g1@g.us', id: 'E1', participant: '5@s.whatsapp.net' }, messageTimestamp: 11,
          message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'M1' }, editedMessage: { conversation: 'hello2' } } } },
        { key: { remoteJid: 'g1@g.us', id: 'R1', participant: '5@s.whatsapp.net' }, messageTimestamp: 12,
          message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'M1' } } } },
        { key: { remoteJid: 'status@broadcast', id: 'S1' }, message: { conversation: 'status' } },
      ],
    });
    expect(seen.msgs.map((m) => m.id)).toEqual(['M1']);
    expect(seen.edits).toEqual([{ chatId: 'g1@g.us', messageId: 'M1', newText: 'hello2' }]);
    expect(seen.dels).toEqual([{ chatId: 'g1@g.us', messageId: 'M1' }]);

    // messages.update shapes emitted by Baileys for edits and revokes
    ev.emit('messages.update', [
      { key: { remoteJid: 'g1@g.us', id: 'M2' }, update: { message: { editedMessage: { message: { conversation: 'fixed' } } } } },
      { key: { remoteJid: 'g1@g.us', id: 'M3' }, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } },
    ]);
    expect(seen.edits).toContainEqual({ chatId: 'g1@g.us', messageId: 'M2', newText: 'fixed' });
    expect(seen.dels).toContainEqual({ chatId: 'g1@g.us', messageId: 'M3' });

    ev.emit('chats.upsert', [
      { id: 'g1@g.us', name: 'ERP', archived: true, muteEndTime: 4102444800 },
      { id: 'status@broadcast' },
    ]);
    ev.emit('chats.update', [{ id: '7@s.whatsapp.net', muteEndTime: 1 }]);
    expect(seen.chats).toContainEqual({ id: 'g1@g.us', type: 'group', name: 'ERP', archived: true, muted: true });
    expect(seen.chats).toContainEqual({ id: '7@s.whatsapp.net', type: 'direct', name: null, muted: false });
    expect(seen.chats.find((c) => c.id === 'status@broadcast')).toBeUndefined();

    ev.emit('group-participants.update', { id: 'g1@g.us', author: 'x', participants: [], action: 'add' });
    ev.emit('groups.update', [{ id: 'g1@g.us' }]);
    await tick();
    expect(target.groupMetadata).toHaveBeenCalledWith('g1@g.us');
    expect(seen.groups.at(-1)).toEqual({ id: 'g1@g.us', subject: 'Renamed', participants: [{ id: '6@s.whatsapp.net', displayName: 'Bob', isAdmin: false }] });

    ev.emit('contacts.upsert', [{ id: '8@lid', phoneNumber: '8@s.whatsapp.net', name: 'Cara' }, { id: '9@s.whatsapp.net' }]);
    expect(seen.contacts).toContainEqual({ id: '8@lid', phoneJid: '8@s.whatsapp.net', lid: '8@lid', savedName: 'Cara' });

    ev.emit('messaging-history.set', {
      chats: [{ id: 'h@g.us', name: 'Hist' }],
      contacts: [{ id: '3@s.whatsapp.net', notify: 'Dan' }],
      messages: [{ key: { remoteJid: 'h@g.us', id: 'H1', participant: '3@s.whatsapp.net' }, messageTimestamp: 1, message: { conversation: 'old' } }],
    });
    expect(seen.msgs.map((m) => m.id)).toContain('H1');
    expect(seen.chats.some((c) => c.id === 'h@g.us')).toBe(true);

    ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    expect(seen.conn.at(-1)).toEqual({ state: 'close', reason: 'restart_required', retry: true });

    await client.close();
    expect(target.end).toHaveBeenCalledWith(undefined);
    expect(target.logout).not.toHaveBeenCalled();

    const bad = accessed.filter((p) => DENY.includes(p) || /^(send|group(Create|Leave|Update|Participants|Invite|Accept|Revoke|Toggle|Setting|Join|MemberAdd)|newsletter|update.*Privacy|addLabel|removeLabel)/.test(p));
    expect(bad).toEqual([]);
    expect(new Set(accessed)).toEqual(new Set(['ev', 'user', 'groupFetchAllParticipating', 'groupMetadata', 'end']));
  });

  it('persists creds on creds.update', async () => {
    const { client, ev, auth, db } = await build();
    await client.connect();
    auth.state.creds.me = { id: '1@s.whatsapp.net' };
    ev.emit('creds.update', {});
    await tick();
    expect(db.prepare("SELECT 1 FROM auth_kv WHERE key='creds'").get()).toBeTruthy();
  });

  it('ignores events from a closed socket', async () => {
    const { client, ev, seen } = await build();
    await client.connect();
    await client.close();
    ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: 'a@g.us', id: '1', participant: 'b@s.whatsapp.net' }, message: { conversation: 'x' } }] });
    expect(seen.msgs).toEqual([]);
  });

  it('unlink calls the logout action then clears auth; close() never does', async () => {
    const { client, target, db, auth } = await build();
    await client.connect();
    auth.state.creds.me = { id: '1@s.whatsapp.net' };
    await auth.saveCreds();
    await client.unlink();
    expect(target.logout).toHaveBeenCalledTimes(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM auth_kv').get() as { n: number }).n).toBe(0);
  });

  it('unlink without a socket rejects', async () => {
    const { client } = await build();
    await expect(client.unlink()).rejects.toThrow();
  });

  it('maps disconnect reasons', () => {
    expect(mapDisconnectReason(401)).toBe('logged_out');
    expect(mapDisconnectReason(515)).toBe('restart_required');
    expect(mapDisconnectReason(440)).toBe('replaced');
    expect(mapDisconnectReason(500)).toBe('bad_session');
    expect(mapDisconnectReason(403)).toBe('forbidden');
    expect(mapDisconnectReason(408)).toBe('connection_lost');
    expect(mapDisconnectReason(428)).toBe('connection_lost');
    expect(mapDisconnectReason(undefined)).toBe('unknown');
  });

  it('close events carry retry=false for logged_out/forbidden/replaced', async () => {
    const { client, ev, seen } = await build();
    await client.connect();
    ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    expect(seen.conn.at(-1)).toEqual({ state: 'close', reason: 'logged_out', retry: false });
  });
});
