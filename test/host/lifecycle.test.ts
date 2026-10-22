import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, KeyringBackend, WaClient } from '../../src/core/contracts.js';
import { resolveUserPaths, type DataPaths } from '../../src/core/paths.js';
import { SERVICE_TOKEN_SUFFIX } from '../../src/core/service.js';
import { keychainAccountId } from '../../src/crypto/index.js';
import { createHost, type HostHandle } from '../../src/host/index.js';

class FakeClient implements WaClient {
  constructor(private readonly auth?: { state: { creds: { me?: unknown } }; saveCreds(): Promise<void> }) {}
  private readonly ee = new EventEmitter();
  connect = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  unlink = vi.fn(async () => undefined);
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
let dir: string;
let paths: DataPaths;
let clients: FakeClient[];
let opened: string[];
const hosts: HostHandle[] = [];
const keys = new Map<string, string>();
const keyring: KeyringBackend = {
  getPassword: (s, a) => keys.get(`${s}/${a}`) ?? null,
  setPassword: (s, a, p) => void keys.set(`${s}/${a}`, p),
  deletePassword: (s, a) => keys.delete(`${s}/${a}`),
};
const logger = pino({ level: 'silent' });
const token = (): string => keys.get(`chatai/${keychainAccountId(paths.projectRoot)}${SERVICE_TOKEN_SUFFIX}`) ?? '';
const masterPresent = (): boolean => [...keys.keys()].some((k) => !k.endsWith(SERVICE_TOKEN_SUFFIX));
const unlinkCalls = (): number => clients.reduce((n, c) => n + c.unlink.mock.calls.length, 0);

const mk = (): HostHandle => {
  const h = createHost(paths, {
    keyring,
    logger,
    waClientFactory: ({ auth }) => {
      const c = new FakeClient(auth);
      clients.push(c);
      return c;
    },
    openUrl: (u) => void opened.push(u),
    lockRetryMs: 30,
    liveQuietMs: 40,
    liveMaxMs: 5000,
    disconnectTimeoutMs: 150,
    settle: { minMs: 0, quietMs: 20, maxMs: 2000 },
  });
  hosts.push(h);
  return h;
};

async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function req(port: number, method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

/** Accept, link, keep default chats: ends in step 'done' with a collector client running. */
async function linked(): Promise<{ h: HostHandle; port: number }> {
  const h = mk();
  await h.ready;
  const { nonce } = await h.ops.mintNonce();
  await h.ops.acceptRisk(nonce);
  await h.ops.startLink();
  (clients[0] as FakeClient).conn(OPEN);
  await until(async () => (await h.ops.state()).step === 'choose_chats');
  await h.ops.submitSelection(null);
  await until(() => clients.length === 2);
  (clients[1] as FakeClient).conn(OPEN);
  const port = (JSON.parse(fs.readFileSync(paths.serviceInfo, 'utf8')) as { port: number }).port;
  return { h, port };
}

/** Starts a disconnect and answers the connection the way WhatsApp would (open) unless offline. */
async function disconnect(h: HostHandle, keepData: boolean, online: boolean) {
  const { nonce } = await h.ops.mintNonce('disconnect');
  const before = clients.length;
  const p = h.ops.disconnect({ keepData, nonce });
  await until(() => clients.length === before + 1);
  if (online) (clients[before] as FakeClient).conn(OPEN);
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-life-'));
  paths = resolveUserPaths(dir);
  clients = [];
  opened = [];
  keys.clear();
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('disconnect', () => {
  it('is refused with only the control token (403) and does nothing', async () => {
    const { port } = await linked();
    const bearer = { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' };
    const r = await req(port, 'POST', '/api/disconnect', bearer, { keepData: false });
    expect(r.status).toBe(403);
    // an accept nonce is not a disconnect nonce
    const acc = JSON.parse((await req(port, 'POST', '/api/mint-nonce', bearer, {})).text) as { nonce: string };
    expect((await req(port, 'POST', '/api/disconnect', { ...bearer, 'X-Disconnect-Nonce': acc.nonce }, { keepData: false })).status).toBe(403);
    expect(fs.existsSync(paths.storeDb)).toBe(true);
    expect(clients.length).toBe(2); // no logout client was created
    expect(unlinkCalls()).toBe(0);
  });

  it('keepData: unlinks once, wipes the session, keeps store and key, ends ready_to_link; the nonce is single-use', async () => {
    const { h } = await linked();
    const collector = clients[1] as FakeClient;
    const { nonce } = await h.ops.mintNonce('disconnect');
    const before = clients.length;
    const p = h.ops.disconnect({ keepData: true, nonce });
    await until(() => clients.length === before + 1);
    (clients[before] as FakeClient).conn(OPEN);
    const s = await p;
    expect(s.step).toBe('ready_to_link');
    expect(s.error).toBeNull();
    expect(collector.close).toHaveBeenCalled();
    expect(unlinkCalls()).toBe(1);
    expect((clients[before] as FakeClient).unlink).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(paths.storeDb)).toBe(true);
    expect(masterPresent()).toBe(true);
    await expect(h.ops.disconnect({ keepData: true, nonce })).rejects.toThrow(/panel or a browser session/);
    expect(unlinkCalls()).toBe(1);
  });

  it('delete everything: removes store, configs, exports, backups and the key; back to needs_accept', async () => {
    const { h } = await linked();
    fs.mkdirSync(paths.exportsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.exportsDir, 'a.csv'), 'x');
    fs.mkdirSync(path.join(dir, 'backups', 'old'), { recursive: true });
    expect(fs.existsSync(paths.config)).toBe(true);
    const s = await disconnect(h, false, true);
    expect(s.step).toBe('needs_accept');
    for (const f of [paths.storeDb, paths.authDb, paths.config, paths.departments, paths.priorities, paths.exportsDir, path.join(dir, 'backups')]) {
      expect(fs.existsSync(f), f).toBe(false);
    }
    expect(masterPresent()).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(true); // the lock stays with this process
    expect(h.role()).toBe('holder');
    expect(unlinkCalls()).toBe(1);
  });

  it('offline: still wipes locally, never calls unlink, and tells the user to remove the device on the phone', async () => {
    const { h } = await linked();
    const s = await disconnect(h, true, false);
    expect(s.step).toBe('ready_to_link');
    expect(s.error).toMatch(/remove the device on your phone: Settings → Linked devices/);
    expect(unlinkCalls()).toBe(0);
    expect(fs.existsSync(paths.storeDb)).toBe(true);
    expect((await h.ops.startLink()).step).toBe('linking'); // linking again works
  });

  it('a browser session works without a nonce (with CSRF) and a replayed cookie-less call does not', async () => {
    const { port, h } = await linked();
    const bearer = { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' };
    await req(port, 'POST', '/api/open-setup', bearer, { screen: 'disconnect' });
    const url = new URL(opened[opened.length - 1] as string);
    expect(url.searchParams.get('screen')).toBe('disconnect');
    const hit = await req(port, 'GET', `/setup?t=${url.searchParams.get('t')}&screen=disconnect`);
    expect(hit.headers.location).toBe('/setup?screen=disconnect');
    const cookie = String(hit.headers['set-cookie']?.[0]).split(';')[0] as string;
    const page = await req(port, 'GET', '/setup', { Cookie: cookie });
    const csrf = (/"csrf":"([^"]+)"/.exec(page.text) as RegExpExecArray)[1] as string;
    const origin = `http://127.0.0.1:${port}`;
    const headers = { Cookie: cookie, 'X-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' };
    expect((await req(port, 'POST', '/api/disconnect', headers, { keepData: 'yes' })).status).toBe(400);
    const pending = req(port, 'POST', '/api/disconnect', headers, { keepData: true });
    await until(() => clients.length === 3);
    (clients[2] as FakeClient).conn(OPEN);
    const r = await pending;
    expect(r.status).toBe(200);
    expect((JSON.parse(r.text) as { step: string }).step).toBe('ready_to_link');
    expect(unlinkCalls()).toBe(1);
    expect(h.role()).toBe('holder');
  });
});

describe('diagnose', () => {
  it('POST /api/diagnose works with the control token and leaks no secrets', async () => {
    const { port } = await linked();
    const bearer = { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' };
    const r = await req(port, 'POST', '/api/diagnose', bearer, {});
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text) as { checks: { name: string; ok: boolean }[] };
    const names = d.checks.map((c) => c.name);
    for (const n of ['data_dir', 'keychain', 'lock_holder', 'link', 'schema', 'collector', 'connection', 'proxy', 'disk', 'backups']) {
      expect(names).toContain(n);
    }
    expect(d.checks.find((c) => c.name === 'keychain')?.ok).toBe(true);
    expect(d.checks.find((c) => c.name === 'lock_holder')?.ok).toBe(true);
    for (const secret of [token(), ...keys.values()]) expect(r.text).not.toContain(secret);
    expect(r.text).not.toMatch(/nonce|<svg/i);
  });
});
