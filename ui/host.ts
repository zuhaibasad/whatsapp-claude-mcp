// Two hosts, one UI: Claude Desktop MCP App panel (postMessage) or plain browser page (fetch).
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import type { SetupOps, SetupState } from '../src/core/service.js';
import { initialScreenFrom, screenFromSearch, unwrap, type InitialScreen, type UiOpName } from './logic.js';

type UiOps = Pick<SetupOps, UiOpName>;

export interface Host {
  /** 'app' = Claude Desktop panel, 'browser' = plain page (picks the permission tip wording). */
  kind: 'app' | 'browser';
  init(): Promise<void>;
  /** Where the opener wants to land: first tool result (panel) or `?screen=` (browser). */
  initialScreen(): Promise<InitialScreen | null>;
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
  disconnect: 'disconnect',
};

function argsFor(op: UiOpName, args: unknown[]): Record<string, unknown> {
  if (op === 'submitSelection') return { selectedIds: args[0] ?? null };
  if (op === 'disconnect') return { keepData: (args[0] as { keepData: boolean } | undefined)?.keepData === true };
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
    kind: 'browser',
    async init() { /* nothing to set up */ },
    async initialScreen() { return screenFromSearch(location.search); },
    async call(op, ...args) {
      return unwrap(op, await post(WIRE_NAME[op], argsFor(op, args))) as never;
    },
    async acceptRisk() { return (await post('accept_risk', {})) as SetupState; },
  };
}

export function mcpAppHost(): Host {
  let app: App | null = null;
  let initial: InitialScreen | null = null;
  let gotResult: () => void = () => {};
  const firstResult = new Promise<void>((r) => { gotResult = r; });
  async function tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!app) throw failure('Not connected to Claude yet.');
    const res = await app.callServerTool({ name: `setup_${name}`, arguments: args });
    const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim();
    if (res.isError) throw failure(text);
    if (res.structuredContent !== undefined) return res.structuredContent;
    try { return JSON.parse(text); } catch { throw failure(text); }
  }
  return {
    kind: 'app',
    async init() {
      app = new App({ name: 'chatai-setup', version: '0.1.0' });
      app.ontoolresult = (params) => {
        initial ??= initialScreenFrom(params.structuredContent);
        gotResult();
      };
      await app.connect();
    },
    async initialScreen() {
      // The opening tool result normally arrives right after connect; do not wait long if it does not.
      await Promise.race([firstResult, new Promise<void>((r) => setTimeout(r, 800))]);
      return initial;
    },
    async call(op, ...args) {
      const a = argsFor(op, args);
      if (op === 'disconnect') a.nonce = window.__WA_DISCONNECT_NONCE__ ?? '';
      return unwrap(op, await tool(WIRE_NAME[op], a)) as never;
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
