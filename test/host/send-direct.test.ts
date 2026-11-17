// whatsapp_send_direct's gate (HolderCore.sendDirect): opt-in, recipient = author of a stored message, native dialog
// confirmation, rate limits, and the reply chat added to the allowlist. The WhatsApp client is a fake.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { ConnectionState, KeyringBackend, RawMessage, WaClient } from '../../src/core/contracts.js';
import { resolveUserPaths, type DataPaths } from '../../src/core/paths.js';
import type { Dialogs } from '../../src/host/dialog.js';
import { createHost, type HostHandle } from '../../src/host/index.js';

class FakeClient implements WaClient {
  constructor(private readonly auth?: { state: { creds: { me?: unknown } }; saveCreds(): Promise<void> }) {}
  private readonly ee = new EventEmitter();
  connect = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  unlink = vi.fn(async () => undefined);
  sendDirectText = vi.fn(async (_jid: string, _text: string) => ({ id: 'sent-1' as string | null }));
  checkOnWhatsApp = vi.fn(async (phones: string[]) => phones.map((p) => ({ phone: p, exists: false, jid: null as string | null })));
  on(event: string, listener: (...a: never[]) => void): void {
    this.ee.on(event, listener as (...a: unknown[]) => void);
  }
  emit(event: string, payload: unknown): void {
    this.ee.emit(event, payload);
  }
  conn(s: ConnectionState): void {
    if (s.state === 'open' && this.auth) {
      this.auth.state.creds.me = { id: s.me.id };
      void this.auth.saveCreds();
    }
    this.emit('connection', s);
  }
}

const OPEN: ConnectionState = { state: 'open', me: { id: '999@s.whatsapp.net', lid: null, pushName: 'Me' } };
const GROUP = '120363000000000001@g.us';
const POSTER = '923001234567@s.whatsapp.net';
const raw = (over: Partial<RawMessage> = {}): RawMessage => ({
  id: 'p1', chatId: GROUP, senderId: POSTER, senderName: 'Ali', ts: Math.floor(Date.now() / 1000), text: 'Panadol 500mg in stock',
  quotedId: null, quotedSenderId: null, mentions: [], isFromMe: false, hasMedia: false, mediaType: null, ...over,
});

let dir: string;
let paths: DataPaths;
let clients: FakeClient[];
let answer: boolean | null;
let asked: string[];
let now: number;
const hosts: HostHandle[] = [];
const keys = new Map<string, string>();
const keyring: KeyringBackend = {
  getPassword: (s, a) => keys.get(`${s}/${a}`) ?? null,
  setPassword: (s, a, p) => void keys.set(`${s}/${a}`, p),
  deletePassword: (s, a) => keys.delete(`${s}/${a}`),
};
const dialogs: Dialogs = {
  confirm: async (_title, text) => { asked.push(text); return answer; },
  pickFolder: async () => null,
};

async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const setConfig = (extra: string): void => {
  const file = paths.config;
  const base = fs.readFileSync(file, 'utf8').replace(/^allow_sending:.*$/m, '');
  fs.writeFileSync(file, `${base}\n${extra}\n`);
};

/** Linked host, live collector, one stored group message from POSTER. */
async function linkedWithPost(): Promise<{ h: HostHandle; c: FakeClient }> {
  const h = createHost(paths, {
    keyring, logger: pino({ level: 'silent' }), dialogs, now: () => Date.now() + now,
    waClientFactory: ({ auth }) => { const c = new FakeClient(auth); clients.push(c); return c; },
    openUrl: () => undefined, lockRetryMs: 30, liveQuietMs: 40, liveMaxMs: 200, disconnectTimeoutMs: 150,
    settle: { minMs: 0, quietMs: 20, maxMs: 2000 },
  });
  hosts.push(h);
  await h.ready;
  const { nonce } = await h.ops.mintNonce();
  await h.ops.acceptRisk(nonce);
  await h.ops.startLink();
  (clients[0] as FakeClient).conn(OPEN);
  await until(async () => (await h.ops.state()).step === 'choose_chats');
  await h.ops.submitSelection(null);
  await until(() => clients.length === 2);
  const c = clients[1] as FakeClient;
  c.conn(OPEN);
  await until(async () => (await h.ops.state()).collector === 'live');
  c.emit('messages', [raw(), raw({ id: 'mine', senderId: '999@s.whatsapp.net', isFromMe: true })]);
  return { h, c };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-send-'));
  paths = resolveUserPaths(dir);
  clients = [];
  asked = [];
  answer = true;
  now = 0; // clock offset (ms) added to the real time
  keys.clear();
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sendDirect', () => {
  it('is refused while allow_sending is off (the default) and never asks or sends', async () => {
    const { h, c } = await linkedWithPost();
    await expect(h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'rate?' })).rejects.toThrow(/allow_sending/);
    expect(asked).toEqual([]);
    expect(c.sendDirectText).not.toHaveBeenCalled();
  });

  it('asks with recipient and exact text, sends to the poster only, then reads their 1-to-1 chat', async () => {
    const { h, c } = await linkedWithPost();
    setConfig('allow_sending: true');
    const r = await h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'Salam, Panadol 500mg ka rate?' });
    expect(r).toMatchObject({ sent: true, reply_tracking: true });
    expect(r.to).toContain('+923001234567');
    expect(asked[0]).toContain('Salam, Panadol 500mg ka rate?');
    expect(asked[0]).toContain('+923001234567');
    expect(c.sendDirectText).toHaveBeenCalledExactlyOnceWith(POSTER, 'Salam, Panadol 500mg ka rate?');
    const cfg = parse(fs.readFileSync(paths.config, 'utf8')) as { allowlist: string[] };
    expect(cfg.allowlist).toContain(POSTER);
  });

  it('does not send when the user says no, or when no dialog can be shown', async () => {
    const { h, c } = await linkedWithPost();
    setConfig('allow_sending: true');
    answer = false;
    expect(await h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'rate?' })).toMatchObject({ sent: false, reason: 'cancelled' });
    answer = null;
    expect(await h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'rate?' })).toMatchObject({ sent: false, reason: 'no_dialog' });
    expect(c.sendDirectText).not.toHaveBeenCalled();
  });

  it('rejects unknown refs, own messages, empty or too-long text, before asking', async () => {
    const { h } = await linkedWithPost();
    setConfig('allow_sending: true');
    await expect(h.ops.sendDirect({ ref: `${GROUP}/nope`, text: 'x' })).rejects.toThrow(/no stored message/);
    await expect(h.ops.sendDirect({ ref: `${GROUP}/mine`, text: 'x' })).rejects.toThrow(/yours/);
    await expect(h.ops.sendDirect({ ref: `${GROUP}/p1`, text: '   ' })).rejects.toThrow(/empty/);
    await expect(h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'x'.repeat(1001) })).rejects.toThrow(/longer/);
    expect(asked).toEqual([]);
  });

  it('a reply arriving right after the send is kept (no wait for the 30 s config poll)', async () => {
    const { h, c } = await linkedWithPost();
    setConfig('allow_sending: true');
    expect((await h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'rate?' })).sent).toBe(true);
    // WhatsApp announces the 1-to-1 chat, then the reply lands, all within a second.
    c.emit('chats', [{ id: POSTER, type: 'direct', unreadCount: 1, lastActivityAt: Math.floor(Date.now() / 1000) }]);
    c.emit('messages', [raw({ id: 'r1', chatId: POSTER, text: '450 per box' })]);
    now += 21_000;
    // The reply is stored only if its chat stayed included: then it is a valid ref to answer.
    await h.ops.sendDirect({ ref: `${POSTER}/r1`, text: 'ok' });
    expect(asked).toHaveLength(2);
  });

  it('an in-Claude approval from previewDirect sends without the OS dialog, once, for that exact text only', async () => {
    const { h, c } = await linkedWithPost();
    setConfig('allow_sending: true');
    const p = await h.ops.previewDirect({ ref: `${GROUP}/p1`, text: '  rate?  ' });
    expect(p).toMatchObject({ text: 'rate?', where: null });
    expect(p.to).toContain('+923001234567');
    expect(c.sendDirectText).not.toHaveBeenCalled(); // preview never sends
    const other = await h.ops.previewDirect({ ref: `${GROUP}/p1`, text: 'rate?' });
    await expect(h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'something else', approval: other.approval })).rejects.toThrow(/approval/);
    await expect(h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'rate?', approval: other.approval })).rejects.toThrow(/approval/); // consumed
    await expect(h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'rate?', approval: 'made-up' })).rejects.toThrow(/approval/);
    expect((await h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'rate?', approval: p.approval })).sent).toBe(true);
    expect(asked).toEqual([]); // no OS dialog
    expect(c.sendDirectText).toHaveBeenCalledExactlyOnceWith(POSTER, 'rate?');
  });

  it('rate-limits: 20 s between messages', async () => {
    const { h, c } = await linkedWithPost();
    setConfig('allow_sending: true');
    await h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'one' });
    await expect(h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'two' })).rejects.toThrow(/wait \d+ s/);
    now += 21_000;
    expect((await h.ops.sendDirect({ ref: `${GROUP}/p1`, text: 'three' })).sent).toBe(true);
    expect(c.sendDirectText).toHaveBeenCalledTimes(2);
  });
});

describe('sendDirect to an existing 1-to-1 chat (no message ref)', () => {
  const A = '923331112222@s.whatsapp.net';
  const B = '923334445555@s.whatsapp.net';
  const withChats = async () => {
    const r = await linkedWithPost();
    const t = Math.floor(Date.now() / 1000);
    r.c.emit('chats', [
      { id: A, type: 'direct', name: 'Ali Traders', lastActivityAt: t },
      { id: B, type: 'direct', name: 'Ali Khan', lastActivityAt: t },
      { id: '999@s.whatsapp.net', type: 'direct', name: 'Me myself', lastActivityAt: t },
      { id: GROUP, type: 'group', name: 'Pharma Stock', lastActivityAt: t },
    ]);
    await until(async () => (await r.h.ops.chatRows()).some((x) => x.id === B));
    setConfig('allow_sending: true');
    return r;
  };

  it('finds the chat by exact name or by phone (leading 0 = 92) and shows the number in the dialog', async () => {
    const { h, c } = await withChats();
    expect((await h.ops.sendDirect({ ref: 'Ali Traders', text: 'Salam' })).sent).toBe(true);
    expect(asked[0]).toContain('+923331112222');
    expect(asked[0]).not.toContain('posted in');
    now += 21_000;
    expect((await h.ops.sendDirect({ ref: '0333 444 5555', text: 'Salam' })).sent).toBe(true);
    expect(c.sendDirectText.mock.calls.map((x) => x[0])).toEqual([A, B]);
  });

  it('refuses ambiguous names, groups, unknown numbers and your own number, before asking', async () => {
    const { h, c } = await withChats();
    await expect(h.ops.sendDirect({ ref: 'Al', text: 'x' })).rejects.toThrow(/matches 2 people/);
    await expect(h.ops.sendDirect({ ref: 'Pharma Stock', text: 'x' })).rejects.toThrow(/nobody matches/);
    await expect(h.ops.sendDirect({ ref: GROUP, text: 'x' })).rejects.toThrow(/nobody matches/);
    await expect(h.ops.sendDirect({ ref: '+92 300 0000000', text: 'x' })).rejects.toThrow(/nobody matches/);
    await expect(h.ops.sendDirect({ ref: 'Me myself', text: 'x' })).rejects.toThrow(/own number/);
    expect(asked).toEqual([]);
    expect(c.sendDirectText).not.toHaveBeenCalled();
  });

  it('one person with a phone chat and a LID chat is one match, sent to the phone JID', async () => {
    const { h, c } = await withChats();
    const LID = '77001@lid';
    c.emit('contacts', [{ id: A, lid: LID, savedName: 'Ali Traders' }]);
    c.emit('chats', [{ id: LID, type: 'direct', name: 'Ali Traders', lastActivityAt: Math.floor(Date.now() / 1000) }]);
    await until(async () => (await h.ops.chatRows()).some((x) => x.id === LID && x.phone !== null));
    expect((await h.ops.sendDirect({ ref: 'Ali Traders', text: 'Salam' })).sent).toBe(true);
    now += 21_000;
    expect((await h.ops.sendDirect({ ref: '03331112222', text: 'again' })).sent).toBe(true);
    expect(c.sendDirectText.mock.calls.map((x) => x[0])).toEqual([A, A]);
  });

  it('an approval for one person cannot send to another', async () => {
    const { h, c } = await withChats();
    const p = await h.ops.previewDirect({ ref: 'Ali Traders', text: 'rate?' });
    await expect(h.ops.sendDirect({ ref: 'Ali Khan', text: 'rate?', approval: p.approval })).rejects.toThrow(/approval/);
    expect(c.sendDirectText).not.toHaveBeenCalled();
  });
});

describe('sendDirect to people known from contacts and stored groups (no chat)', () => {
  const SAEED = '923007770000@s.whatsapp.net';
  const BILAL = '923215550000@s.whatsapp.net';
  const BILAL2 = '923216660000@s.whatsapp.net';
  const KAMRAN_LID = '88001@lid';
  const KAMRAN = '923338880000@s.whatsapp.net';
  const GROUP2 = '120363000000000002@g.us';
  const known = async () => {
    const r = await linkedWithPost();
    r.c.emit('contacts', [{ id: SAEED, phoneJid: SAEED, savedName: 'Dr Saeed' }]);
    r.c.emit('groups', [
      { id: GROUP, subject: 'Pharma Stock', participants: [
        { id: BILAL, displayName: 'Bilal', isAdmin: false },
        { id: KAMRAN_LID, displayName: 'Kamran', isAdmin: false },
        { id: '999@s.whatsapp.net', displayName: 'Me', isAdmin: false },
      ] },
    ]);
    setConfig('allow_sending: true');
    return r;
  };

  it('reaches a saved contact with no chat (exact, case-insensitive or unique fragment) and says so', async () => {
    const { h, c } = await known();
    for (const ref of ['Dr Saeed', 'dr saeed', 'Saeed', '03007770000']) {
      const p = await h.ops.previewDirect({ ref, text: 'Salam' });
      expect(p.how, ref).toBe('saved contact');
      expect(p.to, ref).toContain('+923007770000');
    }
    expect((await h.ops.sendDirect({ ref: 'Dr Saeed', text: 'Salam' })).sent).toBe(true);
    expect(asked[0]).toContain('(saved contact)');
    expect(c.sendDirectText).toHaveBeenCalledExactlyOnceWith(SAEED, 'Salam');
  });

  it('reaches an unsaved group member by phone or exact name, and the dialog names the group', async () => {
    const { h, c } = await known();
    const p = await h.ops.previewDirect({ ref: '0321-555 0000', text: 'rate?' });
    expect(p).toMatchObject({ how: 'member of Pharma Stock' });
    expect(p.to).toContain('Bilal');
    expect((await h.ops.previewDirect({ ref: 'bilal', text: 'rate?' })).to).toContain('+923215550000');
    await expect(h.ops.previewDirect({ ref: 'Bil', text: 'rate?' })).rejects.toThrow(/nobody matches/); // members: exact names only
    expect((await h.ops.sendDirect({ ref: 'Bilal', text: 'rate?' })).sent).toBe(true);
    expect(asked[0]).toContain('(member of Pharma Stock)');
    expect(c.sendDirectText).toHaveBeenCalledExactlyOnceWith(BILAL, 'rate?');
  });

  it('a LID-only member goes to the LID, and to the phone JID once the mapping is known', async () => {
    const { h, c } = await known();
    await h.ops.sendDirect({ ref: 'Kamran', text: 'one' });
    c.emit('contacts', [{ id: KAMRAN, phoneJid: KAMRAN, lid: KAMRAN_LID }]);
    now += 21_000;
    await h.ops.sendDirect({ ref: '03338880000', text: 'two' });
    expect(c.sendDirectText.mock.calls.map((x) => x[0])).toEqual([KAMRAN_LID, KAMRAN]);
  });

  it('refuses an ambiguous name with a short list of candidates, and cold numbers, before asking', async () => {
    const { h, c } = await known();
    c.emit('groups', [{ id: GROUP2, subject: 'Karachi Meds', participants: [{ id: BILAL2, displayName: 'Bilal', isAdmin: false }] }]);
    const err = await h.ops.sendDirect({ ref: 'Bilal', text: 'x' }).catch((e: Error) => e);
    expect(String(err)).toMatch(/matches 2 people/);
    expect(String(err)).toContain('+923215550000 (member of Pharma Stock)');
    expect(String(err)).toContain('+923216660000 (member of Karachi Meds)');
    await expect(h.ops.sendDirect({ ref: '+92 345 1234567', text: 'x' })).rejects.toThrow(/nobody matches.*no cold/);
    await expect(h.ops.sendDirect({ ref: 'Me', text: 'x' })).rejects.toThrow(/nobody matches/); // yourself is not a member
    expect(asked).toEqual([]);
    expect(c.sendDirectText).not.toHaveBeenCalled();
  });

  it('a group-message ref whose author is LID-only is sent to the LID, or the phone JID when mapped', async () => {
    const { h, c } = await known();
    c.emit('messages', [raw({ id: 'k1', senderId: KAMRAN_LID, senderName: 'Kamran', text: 'who has Augmentin?' })]);
    const p = await h.ops.previewDirect({ ref: `${GROUP}/k1`, text: 'I do' });
    expect(p).toMatchObject({ how: 'posted in Pharma Stock', where: 'Pharma Stock' });
    expect((await h.ops.sendDirect({ ref: `${GROUP}/k1`, text: 'I do' })).sent).toBe(true);
    expect(asked[0]).toContain('(posted in Pharma Stock)');
    c.emit('contacts', [{ id: KAMRAN, phoneJid: KAMRAN, lid: KAMRAN_LID }]);
    now += 21_000;
    await h.ops.sendDirect({ ref: `${GROUP}/k1`, text: 'still have it' });
    expect(c.sendDirectText.mock.calls.map((x) => x[0])).toEqual([KAMRAN_LID, KAMRAN]);
  });

  it('a poster of a stored group message is reachable by exact name', async () => {
    const { h } = await known();
    const p = await h.ops.previewDirect({ ref: 'Ali', text: 'rate?' });
    expect(p.how).toBe('posted in Pharma Stock');
    expect(p.to).toContain('+923001234567');
  });
});

describe('checkNumbers (whatsapp_check_number)', () => {
  it('is refused while sending is off, then checks with a 3 s gap and a daily cap; never makes a number sendable', async () => {
    const { h, c } = await linkedWithPost();
    await expect(h.ops.checkNumbers(['03001234567'])).rejects.toThrow(/allow_sending/);
    setConfig('allow_sending: true');
    c.checkOnWhatsApp.mockImplementation(async (phones: string[]) =>
      phones.map((p) => (p === '923451234567' ? { phone: p, exists: true, jid: p + '@s.whatsapp.net' } : { phone: p, exists: false, jid: null })));
    expect(await h.ops.checkNumbers(['0345 1234567', '+92 300 9999999'])).toEqual([
      { phone: '+923451234567', on_whatsapp: true, jid: '923451234567@s.whatsapp.net' },
      { phone: '+923009999999', on_whatsapp: false, jid: null },
    ]);
    expect(c.checkOnWhatsApp).toHaveBeenCalledExactlyOnceWith(['923451234567', '923009999999']);
    await expect(h.ops.checkNumbers(['03001234567'])).rejects.toThrow(/wait \d+ s/);
    await expect(h.ops.checkNumbers([])).rejects.toThrow(/1 to 10/);
    await expect(h.ops.checkNumbers(Array.from({ length: 11 }, (_, i) => '0300000001' + i))).rejects.toThrow(/1 to 10/);
    await expect(h.ops.checkNumbers(['12'])).rejects.toThrow(/7 to 15 digits/);
    // On WhatsApp, but nobody the user knows: still not sendable.
    await expect(h.ops.sendDirect({ ref: '03451234567', text: 'x' })).rejects.toThrow(/nobody matches/);
    // Daily cap: 2 used, 98 left: nine calls of 10 and one of 8 fit, the next does not.
    const ten = (k: number): string[] => Array.from({ length: 10 }, (_, i) => '03' + String(k).padStart(2, '0') + '00000' + i + '0');
    for (let k = 0; k < 9; k++) { now += 3_100; await h.ops.checkNumbers(ten(k)); }
    now += 3_100;
    await h.ops.checkNumbers(ten(20).slice(0, 8));
    now += 3_100;
    await expect(h.ops.checkNumbers(['03111111111'])).rejects.toThrow(/daily limit/);
  });
});
