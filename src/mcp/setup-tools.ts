// whatsapp_setup, the ui:// setup panel resource, and the app-only tools the panel calls.
// App-only tools are registered only when the client advertises MCP Apps support (io.modelcontextprotocol/ui),
// because clients without it (Claude Code) ignore `visibility` and would show them to the model.
import fs from 'node:fs';
import { getUiCapability, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { DataPaths } from '../core/paths.js';
import type { SetupState } from '../core/service.js';
import type { HostBridge } from './host.js';
import type { McpDeps, ToolHandler, ToolResult } from './server.js';
import { text } from './server.js';

export const SETUP_URI = 'ui://wa-bridge/setup.html';
const APP_ONLY = { ui: { resourceUri: SETUP_URI, visibility: ['app'] } };

const PLACEHOLDER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>wa-bridge setup</title></head>
<body><p>The setup panel is not installed in this build. Run <code>wa-bridge link</code> in a terminal, or reinstall wa-bridge.</p></body></html>`;

type PlainFn = (
  name: string,
  description: string,
  schema: z.ZodObject<z.ZodRawShape>,
  annotations: { readOnlyHint: boolean; hidden?: boolean },
  fn: (args: Record<string, unknown>) => Promise<ToolResult>,
  meta?: Record<string, unknown>,
) => void;

export interface SetupUiCtx {
  server: McpServer;
  deps: McpDeps;
  handlers: Map<string, ToolHandler>;
  plain: PlainFn;
  needHost(): Promise<HostBridge>;
  paths: DataPaths;
  /** Forces the capability decision (tests). */
  uiSupported?: boolean;
}

function loadHtml(deps: McpDeps): string {
  if (deps.readUiHtml) return deps.readUiHtml() ?? PLACEHOLDER_HTML;
  try {
    return fs.readFileSync(new URL('../ui/setup.html', import.meta.url), 'utf8');
  } catch {
    return PLACEHOLDER_HTML;
  }
}

/** Never put the QR in text that the model sees: `content` carries only the step and collector state. */
function minimal(s: SetupState): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ step: s.step, collector: s.collector, error: s.error }) }],
    structuredContent: s as unknown as Record<string, unknown>,
  };
}

export function registerSetupUi(ctx: SetupUiCtx): void {
  const { server, deps, plain, needHost } = ctx;
  const uiOn = (): boolean => ctx.uiSupported ?? getUiCapability(server.server.getClientCapabilities()) !== undefined;

  // The panel. A fresh nonce is minted on every read and embedded only in this HTML.
  registerAppResource(server, 'WhatsApp setup panel', SETUP_URI, { description: 'Link WhatsApp and choose which chats wa-bridge reads.' },
    async () => {
      const nonce = await (await needHost()).mintNonce();
      const inject = `<script>window.__WA_NONCE__=${JSON.stringify(nonce)};</script>`;
      const html = loadHtml(deps);
      const withNonce = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html;
      return {
        contents: [{
          uri: SETUP_URI, mimeType: RESOURCE_MIME_TYPE, text: withNonce,
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
        }],
      };
    });

  plain('whatsapp_setup',
    'Open the WhatsApp panel to link an account or choose chats. Use it to set up or re-link, and with screen "chats" whenever the user wants to add, remove or browse chats without naming them.',
    z.object({ screen: z.enum(['auto', 'chats']).optional().describe('"chats" opens the chat picker (when linked); default "auto"') }),
    { readOnlyHint: false },
    async (a) => {
      const screen: 'auto' | 'chats' = a.screen === 'chats' ? 'chats' : 'auto';
      if (uiOn()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ shown: true, message: 'The panel is shown to the user. Wait for them to finish there; do not ask for any codes. Afterwards call whatsapp_status.' }) }],
          structuredContent: { initialScreen: screen },
        };
      }
      await (await needHost()).openSetup(screen);
      return text({ opened_in_browser: true, message: 'I opened the setup page in your browser. Finish the steps there, then tell me and I will check with whatsapp_status.' });
    },
    { ui: { resourceUri: SETUP_URI } });

  let registered = false;
  const registerAppOnly = (): void => {
    if (registered) return;
    registered = true;
    const ops = async () => (await needHost()).ops();
    const none = z.object({});
    plain('setup_state', 'UI only: current setup state.', none, { readOnlyHint: true }, async () => {
      const s = await (await ops()).state();
      // The QR (qrSvg) only goes in structuredContent, never in the text content.
      const rest: Record<string, unknown> = { ...s, qrSvg: undefined };
      return { content: [{ type: 'text', text: JSON.stringify(rest) }], structuredContent: s as unknown as Record<string, unknown> };
    }, APP_ONLY);
    plain('setup_accept_risk', 'UI only: record that the user accepted the risk notice.',
      z.object({ nonce: z.string().min(1) }), { readOnlyHint: false },
      async (a) => minimal(await (await needHost()).acceptRisk(String(a.nonce))), APP_ONLY);
    plain('setup_start_link', 'UI only: start linking WhatsApp (shows a QR in the panel).', none, { readOnlyHint: false },
      async () => minimal(await (await ops()).startLink()), APP_ONLY);
    plain('setup_cancel_link', 'UI only: cancel linking.', none, { readOnlyHint: false },
      async () => minimal(await (await ops()).cancelLink()), APP_ONLY);
    plain('setup_chat_rows', 'UI only: chats for the picker.', none, { readOnlyHint: true }, async () => {
      const rows = await (await ops()).chatRows();
      return { content: [{ type: 'text', text: JSON.stringify({ count: rows.length }) }], structuredContent: { rows } };
    }, APP_ONLY);
    plain('setup_wait_for_sync', 'UI only: wait until the collector is live.',
      z.object({ timeoutMs: z.number().int().min(1).max(120_000).optional() }), { readOnlyHint: true }, async (a) => {
        const r = await (await ops()).waitForSync(typeof a.timeoutMs === 'number' ? a.timeoutMs : 30_000);
        return { content: [{ type: 'text', text: JSON.stringify({ collector: r.collector }) }], structuredContent: { ...r } };
      }, APP_ONLY);
    plain('setup_submit_selection', 'UI only: save the chat selection (null keeps defaults).',
      z.object({ selectedIds: z.array(z.string()).nullable() }), { readOnlyHint: false }, async (a) => {
        const summary = await (await ops()).submitSelection(a.selectedIds as string[] | null);
        return { content: [{ type: 'text', text: JSON.stringify({ saved: summary !== null }) }], structuredContent: { summary } };
      }, APP_ONLY);
  };

  if (ctx.uiSupported === true) registerAppOnly();
  else if (ctx.uiSupported === undefined) {
    const prev = server.server.oninitialized;
    server.server.oninitialized = () => {
      prev?.();
      if (uiOn()) registerAppOnly();
    };
  }
}
