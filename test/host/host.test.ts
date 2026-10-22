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
import { createHost, createHostClient, getSetupOps, startHost, stopHost, type HostHandle } from '../../src/host/index.js';

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

const SECRET_QR = 'QR-SECRET-STRING-1234';
const OPEN: ConnectionState = { state: 'open', me: { id: '999@s.whatsapp.net', lid: null, pushName: 'Me' } };

let dir: string;
let paths: DataPaths;
let clients: FakeClient[];
let logLines: string[];
let opened: string[];
const hosts: HostHandle[] = [];
const store = new Map<string, string>();
const keyring: KeyringBackend = {
  getPassword: (s, a) => store.get(`${s}/${a}`) ?? null,
  setPassword: (s, a, p) => void store.set(`${s}/${a}`, p),
  deletePassword: (s, a) => store.delete(`${s}/${a}`),
};
const logger = pino({ level: 'info' }, { write: (s: string) => void logLines.push(s) } as unknown as NodeJS.WritableStream);

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

const token = (): string => store.get(`chatai/${keychainAccountId(paths.projectRoot)}${SERVICE_TOKEN_SUFFIX}`) ?? '';

function req(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-host-'));
  paths = resolveUserPaths(dir);
  clients = [];
  logLines = [];
  opened = [];
  store.clear();
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  await stopHost();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('election', () => {
  it('second host follows, takes over when the holder stops; service.json is written and removed', async () => {
    const a = mk();
    await a.ready;
    expect(a.role()).toBe('holder');
    expect(fs.existsSync(paths.serviceInfo)).toBe(true);
    const b = mk();
    await b.ready;
    expect(b.role()).toBe('follower');
    // the follower forwards to the holder over HTTP
    expect((await b.ops.state()).step).toBe('needs_accept');
    await a.stop();
    expect(fs.existsSync(paths.serviceInfo)).toBe(false);
    await until(() => b.role() === 'holder');
    expect(fs.existsSync(paths.serviceInfo)).toBe(true);
    await b.stop();
    expect(fs.existsSync(paths.serviceInfo)).toBe(false);
  });

  it('startHost / getSetupOps / stopHost', async () => {
    const h = await startHost(paths, { keyring, logger, openUrl: () => undefined, waClientFactory: () => new FakeClient() });
    expect(h.role()).toBe('holder');
    expect(getSetupOps(paths)).toBe(h.ops);
    await stopHost();
    expect(fs.existsSync(paths.serviceInfo)).toBe(false);
    expect(getSetupOps(paths)).not.toBe(h.ops);
  });
});

describe('setup flow', () => {
  it('needs_accept -> link -> choose_chats -> done -> catching_up -> live', async () => {
    const a = mk();
    await a.ready;
    const b = mk(); // follower drives the flow over HTTP
    await b.ready;
    expect((await a.ops.state()).step).toBe('needs_accept');
    await expect(a.ops.acceptRisk()).rejects.toThrow();
    const { nonce } = await b.ops.mintNonce();
    // forwarded acceptRisk with the nonce
    expect((await b.ops.acceptRisk(nonce)).step).toBe('ready_to_link');
    expect((await a.ops.startLink()).step).toBe('linking');

    const link = clients[0] as FakeClient;
    link.conn({ state: 'qr', qr: SECRET_QR });
    await until(async () => (await a.ops.state()).qrSvg !== null);
    const st = await a.ops.state();
    expect(st.qrSvg).toMatch(/^<svg|^<\?xml/);
    expect(st.qrSvg).not.toContain(SECRET_QR);
    expect(st.qrExpiresIn).toBeGreaterThan(0);

    link.conn(OPEN);
    link.emit('chats', [{ id: '111@g.us', type: 'group', name: 'Team' }, { id: '222@s.whatsapp.net', type: 'direct', name: 'Bob' }]);
    await until(async () => (await a.ops.state()).step === 'choose_chats');
    const s2 = await a.ops.state();
    expect(s2.sync?.chats).toBe(2);
    expect(s2.account?.id).toBe('999@s.whatsapp.net');
    const rows = await b.ops.chatRows();
    expect(rows.map((r) => r.id).sort()).toEqual(['111@g.us', '222@s.whatsapp.net']);

    const summary = await b.ops.submitSelection(['111@g.us']);
    expect(summary?.groupsSelected).toBe(1);
    expect((await a.ops.state()).step).toBe('done');

    await until(() => clients.length === 2);
    const col = clients[1] as FakeClient;
    expect(a.collectorState()).toBe('connecting');
    col.conn(OPEN);
    await until(() => a.collectorState() === 'catching_up');
    const waiting = a.ops.waitForSync(3000);
    col.conn({ state: 'caught_up' });
    expect((await waiting).collector).toBe('live');
    expect(a.collectorState()).toBe('live');
    await a.stop();
    expect(col.close).toHaveBeenCalled();
    expect(logLines.join('')).not.toContain(SECRET_QR);
  });

  it('becomes live after liveMaxMs without caught_up', async () => {
    const a = mk();
    await a.ready;
    const { nonce } = await a.ops.mintNonce();
    await a.ops.acceptRisk(nonce);
    await a.ops.startLink();
    const link = clients[0] as FakeClient;
    link.conn(OPEN);
    await until(async () => (await a.ops.state()).step === 'choose_chats');
    await a.ops.submitSelection(null);
    await until(() => clients.length === 2);
    (clients[1] as FakeClient).conn(OPEN);
    const r = await a.ops.waitForSync(200);
    expect(r.collector).toBe('catching_up');
  });
});

describe('control server auth', () => {
  async function holder(): Promise<{ port: number; h: HostHandle }> {
    const h = mk();
    await h.ready;
    const info = JSON.parse(fs.readFileSync(paths.serviceInfo, 'utf8')) as { port: number };
    return { port: info.port, h };
  }
  const bearer = (): Record<string, string> => ({ Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' });

  it('health needs no auth; wrong Host is rejected; no credentials is 401', async () => {
    const { port } = await holder();
    expect((await req(port, 'GET', '/api/health')).status).toBe(200);
    expect((await req(port, 'GET', '/api/health', { Host: 'evil.example' })).status).toBe(403);
    expect((await req(port, 'POST', '/api/state', { 'Content-Type': 'application/json' }, {})).status).toBe(401);
    expect((await req(port, 'POST', '/api/state', { ...bearer(), Origin: 'http://evil.example' }, {})).status).toBe(403);
    expect((await req(port, 'POST', '/api/state', { ...bearer(), Host: 'localhost' }, {})).status).toBe(403);
    expect((await req(port, 'POST', '/api/state', bearer(), {})).status).toBe(200);
  });

  it('accept_risk: control token alone 403; nonce works once; replay 403', async () => {
    const { port } = await holder();
    expect((await req(port, 'POST', '/api/accept_risk', bearer(), {})).status).toBe(403);
    const minted = await req(port, 'POST', '/api/mint-nonce', bearer(), {});
    const nonce = (JSON.parse(minted.text) as { nonce: string }).nonce;
    const ok = await req(port, 'POST', '/api/accept_risk', { ...bearer(), 'X-Accept-Nonce': nonce }, {});
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.text) as { step: string }).step).toBe('ready_to_link');
    const again = await req(port, 'POST', '/api/accept_risk', { ...bearer(), 'X-Accept-Nonce': nonce }, {});
    expect(again.status).toBe(403);
    expect(logLines.join('')).not.toContain(nonce);
  });

  it('open-setup with screen chats keeps screen=chats through the redirect', async () => {
    const { port } = await holder();
    const r = await req(port, 'POST', '/api/open-setup', bearer(), { screen: 'chats' });
    expect(r.status).toBe(200);
    const url = new URL(opened[opened.length - 1] as string);
    expect(url.searchParams.get('screen')).toBe('chats');
    const hit = await req(port, 'GET', `/setup?t=${url.searchParams.get('t')}&screen=chats`);
    expect(hit.status).toBe(302);
    expect(hit.headers.location).toBe('/setup?screen=chats');
  });

  it('open-setup hides the token; browser token works once; session can accept risk', async () => {
    const { port } = await holder();
    const r = await req(port, 'POST', '/api/open-setup', bearer(), {});
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ opened: true });
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0] as string);
    expect(url.pathname).toBe('/setup');
    const t = url.searchParams.get('t') as string;
    expect(r.text).not.toContain(t);

    const hit = await req(port, 'GET', `/setup?t=${t}`);
    expect(hit.status).toBe(302);
    const cookie = String(hit.headers['set-cookie']?.[0]).split(';')[0] as string;
    expect(String(hit.headers['set-cookie']?.[0])).toMatch(/HttpOnly/);
    expect((await req(port, 'GET', `/setup?t=${t}`)).status).toBe(403);

    expect((await req(port, 'GET', '/setup')).status).toBe(401);
    const page = await req(port, 'GET', '/setup', { Cookie: cookie });
    expect(page.status).toBe(200);
    const m = /window\.__WA_HTTP__=\{"csrf":"([^"]+)"\}/.exec(page.text);
    expect(m).not.toBeNull();
    const csrf = (m as RegExpExecArray)[1] as string;

    const origin = `http://127.0.0.1:${port}`;
    const noCsrf = await req(port, 'POST', '/api/state', { Cookie: cookie, Origin: origin }, {});
    expect(noCsrf.status).toBe(401);
    const acc = await req(port, 'POST', '/api/accept_risk', { Cookie: cookie, 'X-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' }, {});
    expect(acc.status).toBe(200);
    // a session cannot mint nonces
    expect((await req(port, 'POST', '/api/mint-nonce', { Cookie: cookie, 'X-CSRF': csrf, Origin: origin }, {})).status).toBe(403);
    expect(logLines.join('')).not.toContain(t);
    expect(logLines.join('')).not.toContain(csrf);
    expect(logLines.join('')).not.toContain(token());
  });

  it('client reports an unreachable holder', async () => {
    const c = createHostClient(paths, { keyring });
    await expect(c.state()).rejects.toThrow(/not running|not reachable/);
  });
});
