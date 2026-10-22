import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type McpDeps } from '../../src/mcp/server.js';
import { G1, T0, harness, msg, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const UI_CAPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const VISIBLE = ['whatsapp_brief', 'whatsapp_choose_chats', 'whatsapp_items', 'whatsapp_mark_reviewed', 'whatsapp_read', 'whatsapp_setup', 'whatsapp_status'];

async function listTools(deps: McpDeps, capabilities: Record<string, unknown>): Promise<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean } }[]> {
  const { server } = createServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  let res: { result: { tools: { name: string }[] } } | undefined;
  a.onmessage = (m) => {
    if ((m as { id?: number }).id === 2) res = m as unknown as typeof res;
  };
  await a.start();
  await server.connect(b);
  await a.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 't', version: '0' } } } as JSONRPCMessage);
  await a.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  await a.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as JSONRPCMessage);
  await new Promise((r) => setTimeout(r, 100));
  await a.close();
  return res?.result.tools ?? [];
}

describe('tool surface', () => {
  it('exposes exactly 7 model-visible tools, and stays small', async () => {
    h = harness();
    const tools = await listTools(h.deps, {});
    expect(tools.map((t) => t.name).sort()).toEqual(VISIBLE);
    for (const n of ['whatsapp_status', 'whatsapp_brief', 'whatsapp_read']) {
      expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint, n).toBe(true);
    }
    const size = JSON.stringify(tools).length;
    console.log(`tools/list size without UI: ${tools.length} tools, ${size} characters`);
    expect(size).toBeLessThan(6000);
  });

  it('adds only the app-only setup_* tools for a client with UI support', async () => {
    h = harness();
    const names = (await listTools(h.deps, UI_CAPS)).map((t) => t.name);
    expect(names.filter((n) => !n.startsWith('setup_')).sort()).toEqual(VISIBLE);
    expect(names).toContain('setup_state');
  });
});

describe('whatsapp_read', () => {
  it('routes per action and validates required args', async () => {
    h = harness();
    h.store.insertMessage(msg({ id: 'q1', text: 'invoice bhej do', ts: T0 - 20 }));
    expect((await h.call('whatsapp_read', { action: 'chats' })).json.chats).toHaveLength(2);
    expect((await h.call('whatsapp_read', { action: 'messages', chat: G1 })).json.messages).toHaveLength(1);
    expect((await h.call('whatsapp_read', { action: 'search', query: 'invoice', chat: G1 })).json.hits).toHaveLength(1);
    expect((await h.call('whatsapp_read', { action: 'chat_info', chat: G1 })).json.id).toBe(G1);
    for (const [args, what] of [
      [{ action: 'messages' }, '"chat"'], [{ action: 'search' }, '"query"'], [{ action: 'chat_info' }, '"chat"'],
    ] as const) {
      const r = await h.call('whatsapp_read', args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(what);
    }
    expect((await h.call('whatsapp_read', { action: 'nope' })).text).toContain('invalid arguments');
  });
});

describe('whatsapp_items', () => {
  it('routes per action and validates required args', async () => {
    h = harness({ now: () => Date.now() + 3600_000 });
    h.store.insertMessage(msg({ id: 'it1', ts: Math.floor(Date.now() / 1000) }));
    const saved = await h.call('whatsapp_items', { action: 'save', items: [{ ref: `${G1}/it1`, category: 'request', priority: 'high', summary: 'Do it' }] });
    expect(saved.json.saved).toBe(1);
    expect((await h.call('whatsapp_items', { action: 'list', status: 'open' })).json.items).toHaveLength(1);
    const id = saved.json.ids[0];
    expect((await h.call('whatsapp_items', { action: 'update', id, status: 'done' })).json).toEqual({ id, status: 'done' });
    expect((await h.call('whatsapp_items', { action: 'export', format: 'json' })).json.count).toBe(0);
    for (const args of [{ action: 'save' }, { action: 'update', id: 1 }, { action: 'export' }]) {
      const r = await h.call('whatsapp_items', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toContain('needs');
    }
  });
});
