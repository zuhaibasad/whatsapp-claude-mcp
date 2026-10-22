import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../src/core/paths.js';
import type { SetupOps, SetupState } from '../../src/core/service.js';
import type { HostBridge } from '../../src/mcp/host.js';
import { createServer, type McpDeps } from '../../src/mcp/server.js';
import { G2, T0, harness, type Harness } from './helpers.js';

const NONCE = 'NONCE-abc123-secret';
const QR = '<svg>QR-SECRET</svg>';

function state(over: Partial<SetupState> = {}): SetupState {
  return { step: 'linking', qrSvg: QR, qrExpiresIn: 20, account: null, sync: null, collector: 'not_linked', error: null, version: '0.1.0', ...over };
}

function fakeHost() {
  const calls: string[] = [];
  const ops: SetupOps = {
    state: async () => state(),
    acceptRisk: async () => state({ step: 'ready_to_link', qrSvg: null }),
    startLink: async () => state(),
    cancelLink: async () => state({ step: 'ready_to_link', qrSvg: null }),
    chatRows: async () => [],
    submitSelection: async () => null,
    waitForSync: async () => ({ collector: 'live', waitedMs: 1200 }),
  };
  const host: HostBridge = {
    ops: () => ops,
    mintNonce: async () => { calls.push('mint'); return NONCE; },
    openSetup: async () => { calls.push('open'); },
    acceptRisk: async (n) => { calls.push(`accept:${n}`); return state({ step: 'ready_to_link', qrSvg: null }); },
    stop: async () => undefined,
  };
  return { host, calls };
}

let h: Harness;
afterEach(() => h?.cleanup());

function connect(deps: McpDeps, capabilities: Record<string, unknown>) {
  const { server } = createServer(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const waiters = new Map<number, (m: JSONRPCMessage) => void>();
  clientSide.onmessage = (m) => {
    const id = (m as { id?: number }).id;
    if (typeof id === 'number') waiters.get(id)?.(m);
  };
  let next = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
    new Promise((resolve) => {
      const id = next++;
      waiters.set(id, resolve);
      void clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
  return (async () => {
    await clientSide.start();
    await server.connect(serverSide);
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 't', version: '0' } });
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
    return { request, init, close: () => clientSide.close() };
  })();
}

const UI_CAPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const APP_ONLY = ['setup_accept_risk', 'setup_cancel_link', 'setup_chat_rows', 'setup_start_link', 'setup_state', 'setup_submit_selection'];

describe('capability detection', () => {
  it('hides app-only tools from clients without MCP Apps', async () => {
    h = harness();
    const c = await connect(h.deps, {});
    const names: string[] = (await c.request('tools/list')).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('open_setup');
    for (const n of APP_ONLY) expect(names).not.toContain(n);
    await c.close();
  });

  it('lists app-only tools (visibility app) for clients with MCP Apps', async () => {
    h = harness();
    const c = await connect(h.deps, UI_CAPS);
    const tools: { name: string; _meta?: { ui?: { visibility?: string[]; resourceUri?: string } } }[] = (await c.request('tools/list')).result.tools;
    for (const n of APP_ONLY) {
      expect(tools.find((t) => t.name === n)?._meta?.ui?.visibility).toEqual(['app']);
    }
    const open = tools.find((t) => t.name === 'open_setup');
    expect(open?._meta?.ui?.resourceUri).toBe('ui://wa-bridge/setup.html');
    expect(open?._meta?.ui?.visibility).toBeUndefined();
    await c.close();
  });
});

describe('server surface', () => {
  it('has instructions and the three prompts', async () => {
    h = harness();
    const c = await connect(h.deps, {});
    expect(c.init.result.instructions).toContain('read-only');
    expect(c.init.result.instructions.split('\n').length).toBeLessThanOrEqual(25);
    const prompts: { name: string }[] = (await c.request('prompts/list')).result.prompts;
    expect(prompts.map((p) => p.name).sort()).toEqual(['daily_brief', 'department_report', 'mentions']);
    const got = await c.request('prompts/get', { name: 'daily_brief' });
    expect(got.result.messages[0].content.text).toContain('get_new_messages');
    await c.close();
  });
});

describe('open_setup', () => {
  it('with MCP Apps support: shows the panel and does not open a browser', async () => {
    const f = fakeHost();
    h = harness({ getHost: () => f.host });
    const c = await connect(h.deps, UI_CAPS);
    const r = await c.request('tools/call', { name: 'open_setup', arguments: {} });
    expect(r.result.content[0].text).toContain('panel is shown');
    expect(f.calls).toEqual([]);
    await c.close();
  });

  it('without MCP Apps support: asks the host to open the browser and returns no URL or token', async () => {
    const f = fakeHost();
    h = harness({ getHost: () => f.host });
    const c = await connect(h.deps, {});
    const r = await c.request('tools/call', { name: 'open_setup', arguments: {} });
    const body = r.result.content[0].text as string;
    expect(f.calls).toEqual(['open']);
    expect(body).toContain('opened the setup page in your browser');
    expect(body).not.toMatch(/https?:|127\.0\.0\.1|token|\?t=/i);
    await c.close();
  });

  it('says the collector is starting when the host is not ready', async () => {
    h = harness();
    const c = await connect(h.deps, {});
    const r = await c.request('tools/call', { name: 'open_setup', arguments: {} });
    expect(r.result.isError).toBe(true);
    await c.close();
  });
});

describe('setup panel resource and app tools', () => {
  it('serves the HTML with a fresh nonce and never leaks it through tool results', async () => {
    const f = fakeHost();
    h = harness({ getHost: () => f.host, readUiHtml: () => '<html><head><title>x</title></head><body>ui</body></html>' });
    const c = await connect(h.deps, UI_CAPS);
    const res = await c.request('resources/read', { uri: 'ui://wa-bridge/setup.html' });
    const item = res.result.contents[0];
    expect(item.mimeType).toBe('text/html;profile=mcp-app');
    expect(item.text).toContain(`window.__WA_NONCE__=${JSON.stringify(NONCE)}`);
    expect(f.calls).toEqual(['mint']);

    const results: string[] = [];
    const calls: [string, Record<string, unknown>][] = [
      ['open_setup', {}], ['get_status', {}], ['wait_for_sync', {}], ['setup_state', {}],
      ['setup_accept_risk', { nonce: NONCE }], ['setup_start_link', {}], ['setup_cancel_link', {}],
      ['setup_chat_rows', {}], ['setup_submit_selection', { selectedIds: null }],
    ];
    for (const [name, args] of calls) {
      const r = await c.request('tools/call', { name, arguments: args });
      expect(r.result, name).toBeDefined();
      results.push(JSON.stringify(r.result));
    }
    expect(results.join('\n')).not.toContain(NONCE);
    expect(f.calls).toContain(`accept:${NONCE}`);
    await c.close();
  });

  it('puts the QR only in structuredContent, never in text content', async () => {
    const f = fakeHost();
    h = harness({ getHost: () => f.host });
    const c = await connect(h.deps, UI_CAPS);
    for (const name of ['setup_state', 'setup_start_link']) {
      const r = await c.request('tools/call', { name, arguments: {} });
      expect(JSON.stringify(r.result.content)).not.toContain('QR-SECRET');
      expect(r.result.structuredContent.qrSvg).toBe(QR);
    }
    await c.close();
  });

  it('falls back to a placeholder when the UI build is missing', async () => {
    const f = fakeHost();
    h = harness({ getHost: () => f.host, readUiHtml: () => null });
    const c = await connect(h.deps, UI_CAPS);
    const res = await c.request('resources/read', { uri: 'ui://wa-bridge/setup.html' });
    expect(res.result.contents[0].text).toContain('not installed');
    await c.close();
  });
});

describe('wait_for_sync and get_status', () => {
  it('wait_for_sync reports the collector state', async () => {
    const f = fakeHost();
    h = harness({ getHost: () => f.host });
    const r = await h.call('wait_for_sync', { timeout_seconds: 5 });
    expect(r.json).toMatchObject({ collector: 'live', ready: true });
  });

  it('get_status includes collector state and last_live_at', async () => {
    h = harness();
    h.store.setMeta('collector_state', 'catching_up');
    h.store.setMeta('last_live_at', String(T0 - 600));
    const r = await h.call('get_status');
    expect(r.json.collector).toBe('catching_up');
    expect(r.json.last_live_at).toContain('2025');
    expect(r.json.warnings.join(' ')).toContain('wait_for_sync');
  });

  it('tells the user to set up WhatsApp when not linked', async () => {
    h = harness();
    h.store.upsertAccount({ id: '923001234567:5@s.whatsapp.net', linkStatus: 'unlinked' });
    const r = await h.call('get_status');
    expect(r.json.collector).toBe('not_linked');
    expect(r.json.warnings.join(' ')).toContain('set up WhatsApp');
  });
});

describe('set_chat_inclusion', () => {
  it('resolves names, writes config and reports what changed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-sel-'));
    const paths = resolvePaths(dir);
    h = harness({ projectRoot: dir, paths });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const off = await h.call('set_chat_inclusion', { exclude: ['اردو گروپ'] });
    expect(off.json.turned_off).toEqual(['اردو گروپ']);
    expect(off.json.turned_on).toEqual([]);
    expect(fs.readFileSync(paths.config, 'utf8')).toContain(G2);
    const on = await h.call('set_chat_inclusion', { include: ['اردو گروپ'] });
    expect(on.json.turned_on).toEqual(['اردو گروپ']);
    expect(on.json.note).toContain('new messages');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on unknown chats and empty input', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-sel-'));
    h = harness({ projectRoot: dir, paths: resolvePaths(dir) });
    expect((await h.call('set_chat_inclusion', { include: ['nope-xyz'] })).isError).toBe(true);
    expect((await h.call('set_chat_inclusion', {})).isError).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
