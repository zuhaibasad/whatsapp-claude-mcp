import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/mcp/server.js';
import { T0, harness, msg, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h.cleanup());

describe('MCP over a linked in-memory transport', () => {
  it('initialises, lists all tools and answers tools/call', async () => {
    h = harness();
    h.store.insertMessage(msg({ ts: T0 - 10, text: 'salam 👋' }));
    const { server } = createServer(h.deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const inbox: JSONRPCMessage[] = [];
    const waiters = new Map<number, (m: JSONRPCMessage) => void>();
    clientSide.onmessage = (m) => {
      inbox.push(m);
      const id = (m as { id?: number }).id;
      if (typeof id === 'number') waiters.get(id)?.(m);
    };
    await clientSide.start();
    await server.connect(serverSide);

    let next = 1;
    const request = (method: string, params: Record<string, unknown>): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
      new Promise((resolve) => {
        const id = next++;
        waiters.set(id, resolve);
        void clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
      });

    const init = await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    expect(init.result.serverInfo.name).toBe('chatai');
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

    const list = await request('tools/list', {});
    const names = list.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      'whatsapp_brief', 'whatsapp_choose_chats', 'whatsapp_items', 'whatsapp_mark_reviewed', 'whatsapp_read', 'whatsapp_setup', 'whatsapp_status',
    ]);
    for (const t of list.result.tools) expect(t.description.length).toBeGreaterThan(40);

    const call = await request('tools/call', { name: 'whatsapp_brief', arguments: { wait_for_sync_seconds: 0 } });
    const body = JSON.parse(call.result.content[0].text);
    expect(body.new_messages.chats[0].messages[0].text).toBe('salam 👋');

    const bad = await request('tools/call', { name: 'whatsapp_read', arguments: { action: 'messages', chat: 'nope' } });
    expect(bad.result.isError).toBe(true);

    await clientSide.close();
  });
});
