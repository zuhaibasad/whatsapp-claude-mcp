// Two hosts, one UI: Claude Desktop MCP App panel (postMessage) or plain browser page (fetch).
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import type { SetupOps, SetupState } from '../src/core/service.js';
import { unwrap, type UiOpName } from './logic.js';

type UiOps = Pick<SetupOps, UiOpName>;

export interface Host {
  init(): Promise<void>;
  call<K extends UiOpName>(op: K, ...args: Parameters<UiOps[K]>): Promise<Awaited<ReturnType<UiOps[K]>>>;
  acceptRisk(): Promise<SetupState>;
  notifyDone?(summary: string): Promise<void>;
}

/** Tool/route name for each op (wire names are snake_case per the T14 spec). */
export const WIRE_NAME: Record<UiOpName | 'acceptRisk', string> = {
  state: 'state',
  acceptRisk: 'accept_risk',
  startLink: 'start_link',
  cancelLink: 'cancel_link',
  chatRows: 'chat_rows',
  submitSelection: 'submit_selection',
};

function argsFor(op: UiOpName, args: unknown[]): Record<string, unknown> {
  if (op === 'submitSelection') return { selectedIds: args[0] ?? null };
  return {};
}

function failure(text: string): Error {
  return new Error(text || 'Something went wrong. Please try again.');
}

export function httpHost(): Host {
  const csrf = window.__WA_HTTP__?.csrf ?? '';
  async function post(name: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`/api/${name}`, {
      method: 'POST',
      headers: { 'X-CSRF': csrf, 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    let data: unknown = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
      throw failure(msg);
    }
    return data;
  }
  return {
    async init() { /* nothing to set up */ },
    async call(op, ...args) {
      return unwrap(op, await post(WIRE_NAME[op], argsFor(op, args))) as never;
    },
    async acceptRisk() { return (await post('accept_risk', {})) as SetupState; },
  };
}

export function mcpAppHost(): Host {
  let app: App | null = null;
  async function tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!app) throw failure('Not connected to Claude yet.');
    const res = await app.callServerTool({ name: `setup_${name}`, arguments: args });
    const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim();
    if (res.isError) throw failure(text);
    if (res.structuredContent !== undefined) return res.structuredContent;
    try { return JSON.parse(text); } catch { throw failure(text); }
  }
  return {
    async init() {
      app = new App({ name: 'wa-bridge-setup', version: '0.1.0' });
      await app.connect();
    },
    async call(op, ...args) {
      return unwrap(op, await tool(WIRE_NAME[op], argsFor(op, args))) as never;
    },
    async acceptRisk() { return (await tool('accept_risk', { nonce: window.__WA_NONCE__ ?? '' })) as SetupState; },
    async notifyDone(summary) {
      try { await app?.updateModelContext({ content: [{ type: 'text', text: summary }] }); } catch { /* best-effort */ }
    },
  };
}

export function pickHost(): Host {
  return window.__WA_HTTP__ ? httpHost() : mcpAppHost();
}
