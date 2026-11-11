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
