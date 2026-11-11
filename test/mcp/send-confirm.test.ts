// whatsapp_send_direct confirmation: inside Claude (MCP elicitation) when the client supports it, else the OS pop-up.
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../src/core/paths.js';
import type { SendDirectResult, SendPreview } from '../../src/core/service.js';
import type { HostBridge } from '../../src/mcp/host.js';
import { createServer } from '../../src/mcp/server.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

type Elicit = { action: 'accept' | 'decline' | 'cancel'; delayMs: number } | 'method_not_found';

async function sendVia(caps: Record<string, unknown>, elicit: Elicit) {
  h?.cleanup();
  h = harness();
  const cfg = resolvePaths(h.dir).config;
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'allow_sending: true\n');
  const sends: { ref: string; text: string; approval?: string }[] = [];
  const prompts: string[] = [];
  const ops = {
    previewDirect: async (a: { ref: string; text: string }): Promise<SendPreview> => ({ to: 'Ali +923001234567', where: 'Pharma Traders', text: a.text, approval: 'APPROVAL-1' }),
    sendDirect: async (a: { ref: string; text: string; approval?: string }): Promise<SendDirectResult> => {
      sends.push(a);
      return { sent: true, to: 'Ali +923001234567', reply_tracking: true };
    },
  };
  const host = { ops: () => ops } as unknown as HostBridge;
  const { server } = createServer({ ...h.deps, getHost: () => host });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let result: { result?: { content: { text: string }[] } } | undefined;
  a.onmessage = (m) => {
    const msg = m as { id?: number | string; method?: string; params?: { message?: string } };
    if (msg.method === 'elicitation/create' && msg.id !== undefined) {
      prompts.push(msg.params?.message ?? '');
      const reply = elicit === 'method_not_found'
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }
        : { jsonrpc: '2.0', id: msg.id, result: { action: elicit.action } };
      setTimeout(() => void a.send(reply as JSONRPCMessage), elicit === 'method_not_found' ? 0 : elicit.delayMs);
    } else if (msg.id === 2) {
      result = m as typeof result;
    }
  };
  await a.start();
  await server.connect(b);
  await a.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: caps, clientInfo: { name: 't', version: '0' } } } as JSONRPCMessage);
  await a.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  await a.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whatsapp_send_direct', arguments: { ref: 'g@g.us/p1', text: 'Panadol ka rate?' } } } as JSONRPCMessage);
  for (let i = 0; i < 300 && !result; i++) await new Promise((r) => setTimeout(r, 10));
  await a.close();
  return { sends, prompts, out: JSON.parse(result?.result?.content[0]?.text ?? '{}') as Record<string, unknown> };
}

describe('whatsapp_send_direct confirmation', () => {
  it('asks inside Claude and sends with the approval (no OS pop-up) when the user accepts', async () => {
    const r = await sendVia({ elicitation: {} }, { action: 'accept', delayMs: 1500 });
    expect(r.prompts[0]).toContain('Ali +923001234567');
    expect(r.prompts[0]).toContain('Panadol ka rate?');
    expect(r.sends).toEqual([{ ref: 'g@g.us/p1', text: 'Panadol ka rate?', approval: 'APPROVAL-1' }]);
    expect(r.out.sent).toBe(true);
  });

  it('sends nothing when the user declines inside Claude', async () => {
    const r = await sendVia({ elicitation: {} }, { action: 'decline', delayMs: 1500 });
    expect(r.sends).toEqual([]);
    expect(r.out).toMatchObject({ sent: false, reason: 'cancelled' });
  });

  it('falls back to the OS pop-up (no approval) when the client cannot ask', async () => {
    for (const [caps, elicit] of [
      [{}, { action: 'accept', delayMs: 0 }], // no elicitation capability: never asked
      [{ elicitation: {} }, 'method_not_found'], // declared but not implemented
      [{ elicitation: {} }, { action: 'cancel', delayMs: 0 }], // auto-declined faster than a person could
    ] as const) {
      const r = await sendVia(caps, elicit);
      expect(r.sends, JSON.stringify(caps)).toEqual([{ ref: 'g@g.us/p1', text: 'Panadol ka rate?' }]);
    }
  });
});
