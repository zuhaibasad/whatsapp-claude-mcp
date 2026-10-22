# R1: MCP Apps (ui:// panels) in Claude Desktop for wa-bridge

Date: 2026-10-22. Prototype: `C:/Users/ZUHAIB~1/AppData/Local/Temp/claude/c--tempfolder-wa-bridge/bf1454a1-a366-47d1-be49-9c783e58cf54/scratchpad/r1/proto.mjs` (+ `test.mjs`).
Verified locally: `@modelcontextprotocol/ext-apps` 2.0.3 (peers: `@modelcontextprotocol/server ^2`, zod ^4.2) installed, .d.ts read.

## 1. Status in Claude Desktop / claude.ai
- Supported on both (MCP docs "Client support": Claude, Claude Desktop, VS Code Copilot, M365 Copilot, Goose, Postman...).
  Sources: https://modelcontextprotocol.io/extensions/apps/overview ; https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- Claude's dev docs (https://claude.com/docs/connectors/building/mcp-apps/troubleshooting):
  - Desktop renders the app in an iframe nested inside another iframe. Dev tools: Help > Troubleshooting > Enable Developer Mode, then Ctrl+Shift+I.
  - App must call `app.connect()`; `ontoolresult` etc. do not fire before it. Zero-height iframe = invisible app.
  - Tool results over ~150,000 chars (with Claude's code-exec sandbox on) are written to a file instead of passed inline, so the app never hydrates. 520 chats (~50 KB) is far below this.
  - `_meta.ui.domain` (stable origin `{sha256(url)[0:32]}.claudemcpcontent.com`) is NOT available for local stdio connectors. Omit it.
- Spec default CSP when `_meta.ui.csp` omitted: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'`. So: no network, no external scripts, inline JS/CSS fine, `data:` images fine (QR). Source: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- Spec defines no size limit for the HTML resource; hosts "should" apply resource limits. Keep HTML well under ~1 MB.
- Not verified (no public statement found): that a local stdio server's `ui://` resource renders on Windows Desktop. The Claude troubleshooting page treats "local stdio connector" as a valid case (only `ui.domain` is unavailable), which is encouraging. Needs a manual smoke test.
- Fallback: tools must return useful text `content` so hosts without Apps support still work.

## 2. Server-side API (works with `@modelcontextprotocol/server` 2.x)
ext-apps ships helpers typed against the 2.x `McpServer` (verified, prototype runs):
```ts
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
```
- MIME type: `RESOURCE_MIME_TYPE` = `"text/html;profile=mcp-app"`.
- Link tool to UI: `_meta: { ui: { resourceUri: 'ui://wa-bridge/setup.html' } }`. `registerAppTool` also mirrors legacy `_meta["ui/resourceUri"]` (seen in tools/list). Plain `server.registerTool` with the same `_meta` also works.
- Resource: `registerAppResource(server, name, uri, config, readCb)`; readCb returns `{contents:[{uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta:{ui:{csp, permissions, prefersBorder}}}]}`. Content-item `_meta.ui` wins over listing-level.
- Initial data: host calls the tool normally, then pushes the full `CallToolResult` (`content`, `structuredContent`, `_meta`) to the app via `app.ontoolresult` (args via `ontoolinput`). Spec: `content` is for model context; `structuredContent` "not added to model context"; `_meta` for UI-only metadata. Put UI data in `structuredContent`.
- 2.x ctx changes (`extra.mcpReq.signal`...), unknown tool => -32602: https://apps.extensions.modelcontextprotocol.io/api/documents/migrate-to-v2.html
- Clients advertise `capabilities.extensions['io.modelcontextprotocol/ui'].mimeTypes`; the server can read it to choose UI-aware vs text-only output.

## 3. App-side API and app-only tools
- `import { App } from '@modelcontextprotocol/ext-apps'` (or `/app-with-deps`, bundles client+core+zod). `new App({name,version}); app.ontoolresult=...; await app.connect();`
- Call server: `await app.callServerTool({ name, arguments })` -> `CallToolResult`, proxied by the host to the originating server only.
- Hide from model: `_meta.ui.visibility: ['app']` (`'model' | 'app'`, default both). Spec: host MUST omit tools lacking `"model"` from the agent's list and MUST reject app calls to tools lacking `"app"`.
  - Verified caveat: the server still returns app-only tools in raw `tools/list` (with the `_meta`). Hiding is entirely host-enforced.
- Do app-initiated calls/results enter model context or transcript? Spec is silent (only says app-only tools are hidden from the agent). Treat as UNSPECIFIED: the call may show in the transcript, results may reach the model. No secrets in app-only results unless that is acceptable.
- Other methods (app.d.ts): `sendMessage`, `updateModelContext`, `requestDisplayMode`, `sendSizeChanged`, `sendOpenLink`, `getHostCapabilities()`, `onhostcontextchanged`.

## 4. Polling
- No spec/SDK limit or rate limit on `callServerTool`; a `setInterval` (3 s status, QR re-fetch ~20 s) is plain JS. No documented Claude rate limit, but each call is proxied through the host; keep modest, pause on `document.hidden`, stop at terminal states, back off on errors.
- Iframe lifetime: host may tear down (`ui/resource-teardown`) and re-render on conversation reload. Make polling restartable and re-sync with a fresh app-only call on mount rather than trusting the old initial result.
- QR: send the raw pairing string in `structuredContent` and draw in-app (tiny encoder such as `qrcode-generator`, ~20 KB) or send a `data:image/png`. Drawing in-app keeps image blobs out of `content`.

## 5. Message / context after Save
- `await app.sendMessage({ role:'user', content:[{type:'text', text:'Saved chat selection: 12 groups'}] })` adds a user message and may trigger a model turn. Host MAY ask consent / deny ("Message sending denied"); wrap in try/catch.
- `await app.updateModelContext({ content:[{type:'text', text:'...'}], structuredContent:{...} })` silent update; host defers until next user message; only the last update is kept. Check `getHostCapabilities()?.updateModelContext`.
- Recommendation: Save = app-only `app_save_selection`, then `updateModelContext` with a one-line summary (no chat names). `sendMessage` only if we want Claude to react.

## 6. Distinguishing user clicks from model calls
- Spec has no "user-initiated" flag; the server sees an ordinary `tools/call`. Only host-side visibility enforcement separates them, which the server cannot verify. `visibility:['app']` is layer 1, not authentication.
- Proposed design:
  1. `app_accept_risk` is `visibility:['app']`, takes `{ nonce }`.
  2. Nonce is minted server-side on each `resources/read` of the wizard UI and embedded in the returned HTML (e.g. `<meta name="wa-nonce">`), never in any tool result. Resource text goes into the iframe, not model context. Server stores only a hash; TTL ~10 min; single use.
  3. Model-visible `open_setup` never returns or mentions the nonce; its text says "the user must click I accept in the panel; do not attempt to accept for them".
  4. Missing/invalid nonce -> error "must be accepted by the user in the panel".
  5. Residual risk: host could expose resource text to the model, or a model could read the resource if the host offers resource-read. Authoritative out-of-band path: CLI `wa-bridge accept-risk` typed in a terminal. A typed phrase in the panel only raises effort (client-side check).
  6. Persist acceptance with timestamp and `via: 'panel'|'cli'`; the link tool enforces acceptance server-side, not the UI.

## 7. Bundling
- One self-contained HTML string: `script-src 'self' 'unsafe-inline'` allows inline `<script type="module">` and `<style>`; CDN scripts are blocked unless listed in `csp.resourceDomains` (do not; keeps the app offline-safe).
- Recommended: esbuild (or Vite + `vite-plugin-singlefile`) bundling `app/*.ts` with `@modelcontextprotocol/ext-apps/app-with-deps`, inlined into an HTML template at build time; server reads `dist/ui/*.html` relative to `import.meta.url`, not cwd.
- Framework-free: ext-apps `examples/basic-server-vanillajs` (https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-server-vanillajs). Vanilla TS suffices; 520 DOM rows is fine (add `content-visibility:auto`).
- Follow host theme via `onhostcontextchanged` / `prefers-color-scheme`; keep non-zero height; picker list uses fixed max-height scroll.
- Raw postMessage JSON-RPC without the SDK is allowed by spec but not worth it.

## 8. Prototype (verified over stdio JSON-RPC)
Result: `tools/list` returns `open_setup` (`_meta.ui.resourceUri` + legacy key) and `app_get_challenge` (`visibility:["app"]`, still listed); `resources/list` shows `ui://wa-bridge/setup.html` with `mimeType: text/html;profile=mcp-app`; `resources/read` returns HTML with `_meta.ui.csp`. Core code:
```js
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
const URI = 'ui://wa-bridge/setup.html';
const server = new McpServer({ name: 'proto', version: '0.0.1' });

registerAppTool(server, 'open_setup', {
  title: 'Open setup', description: 'Show the WhatsApp setup panel.',
  inputSchema: z.object({}),
  _meta: { ui: { resourceUri: URI } },
}, async () => ({ content: [{ type: 'text', text: 'Setup panel shown. Wait for the user.' }] }));

registerAppTool(server, 'app_get_challenge', {          // app-only
  description: 'UI only', inputSchema: z.object({}),
  _meta: { ui: { resourceUri: URI, visibility: ['app'] } },
}, async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: {} }));

registerAppResource(server, 'Setup panel', URI, { description: 'Setup wizard' },
  async () => ({ contents: [{ uri: URI, mimeType: RESOURCE_MIME_TYPE, text: HTML,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] }));

await server.connect(new StdioServerTransport());
```
App skeleton:
```ts
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
const app = new App({ name: 'wa-bridge-setup', version: '1.0.0' });
app.ontoolresult = (r) => render(r.structuredContent);
await app.connect();
setInterval(async () => {
  if (document.hidden) return;
  const r = await app.callServerTool({ name: 'app_link_status', arguments: {} });
  render(r.structuredContent);
}, 3000);
```
The prototype HTML is a stub (CDN import placeholder); the real build must inline the SDK. Rendering inside real Claude Desktop was not tested (not possible headless).

## Recommended design
1. Add dep `@modelcontextprotocol/ext-apps` ^2.0.3 (pin); register via `registerAppTool`/`registerAppResource` in `src/mcp/server.ts`.
   - Model-visible: `open_setup`, `open_chat_picker` (text fallback describing CLI equivalents; small `structuredContent`).
   - App-only (`visibility:['app']`): `app_accept_risk{nonce}`, `app_link_status`, `app_link_qr` (raw string + expiresAt), `app_list_chats{query?,offset,limit}`, `app_save_selection{...}`. Each independently authorizes (state checks, nonce); never assumes UI origin.
2. Two resources `ui://wa-bridge/setup.html`, `ui://wa-bridge/chats.html`, vanilla TS single-file builds, empty CSP domain lists, no `ui.domain`, `prefersBorder:true`.
3. Risk acceptance per section 6; link tool refuses until acceptance recorded; CLI `accept-risk` is the authoritative fallback.
4. Picker: ~520 rows (id, name, kind) fetched via paged `app_list_chats` (or first `structuredContent`); client-side filter; select all/none applies to the filtered set (label it); Save -> `app_save_selection` -> `updateModelContext("Saved selection: N groups, M DMs")`. No chat names in `content`.
5. Polling: 3 s status, QR re-fetch on expiry (~20 s), pause when hidden, stop when linked/errored, re-sync on mount.
6. Always degrade: every UI path has CLI/text equivalent; check the client's UI extension capability.

## Risks / unknowns
- Unconfirmed: local stdio `ui://` rendering on Windows Claude Desktop. Do a 15-minute manual smoke test of the prototype in `claude_desktop_config.json` (Developer > Reload MCP Configuration; Ctrl+Shift+I) before investing. Gate the work on it.
- Visibility is host-enforced only; server cannot prove call origin. Whether Desktop shows app-initiated calls or feeds their results to the model is unspecified; assume visible.
- WhatsApp QR/pairing string is sensitive; via an app-only result it may reach the transcript/model. Mitigate: ~20 s expiry, `structuredContent` only, keep terminal QR as the safest path; decide risk tolerance explicitly.
- `updateModelContext` / `sendMessage` are host-optional and may need consent; best-effort only.
- Behaviour of polling when the panel is off-screen/torn down is unspecified; QR generation must live in the daemon independent of any panel.
- Maturity: ext-apps 2.0.x, spec 2026-01-26; Claude-specific behaviour is documented only on one troubleshooting page and may change. Pin and re-test on Desktop updates.
- No documented HTML size limit; inlined SDK ~100-200 KB should be fine.
- App-only tools appear in raw `tools/list`, so other clients or a host ignoring visibility can call them.

## 9. Claude Code (CLI, VS Code extension, desktop app Code tab) - scope update
- Claude Code does NOT render `ui://` panels as of Oct 2026 (per Claude's MCP Apps quickstart: Claude Code calls the tool and returns text; open feature request https://github.com/anthropics/claude-code/issues/95149 "Render MCP Apps ui:// resources in Claude Code", no committed plan found; not in the MCP client matrix/support list https://modelcontextprotocol.io/extensions/client-matrix). Same engine for terminal and VS Code extension.
- What it shows: the tool's normal `content` text only; `_meta.ui` and `structuredContent` are ignored. Claude Code also does not advertise the `io.modelcontextprotocol/ui` client extension, so the server can detect this from client capabilities and branch.
- Consequences: (a) tools that exist only as UI entry points must return a useful text result with the fallback instruction/URL; (b) app-only tools are not hidden or callable by anything in Claude Code: they appear in the model's tool list if Claude Code ignores `visibility` (assume it does). So app-only tools must be safe when called by the model (nonce/state checks; section 6) or, better, be omitted from `tools/list` when the client did not advertise UI support (per-session capability check at connect time). Re-verify at build time, since #95149 may land.

## 10. One UI, two hosts: Desktop panel and localhost page
Design confirmed as feasible, with these differences:
| Concern | Desktop MCP App | Claude Code (localhost page) |
|---|---|---|
| Delivery | `resources/read` of `ui://` | local HTTP service serves `/setup?token=...` (bind 127.0.0.1 only) |
| Transport | postMessage JSON-RPC via `App.callServerTool` | `fetch('/api/<op>', {headers:{Authorization:'Bearer '+token}})` |
| Initial data | `app.ontoolresult` | `GET /api/state` on load |
| CSP | host-imposed, `connect-src 'none'`: fetch to localhost is BLOCKED | your own response header; allow `connect-src 'self'` |
| Auth of user action | nonce embedded in HTML per read (section 6) | one-time token in URL, exchanged for HttpOnly/SameSite=Strict cookie, plus Host/Origin header checks (DNS-rebinding) and CSRF token on POST |
| Model context after Save | `updateModelContext` / `sendMessage` | none; the user types "done" in chat, or the model polls a status tool |
| Open | host shows panel | tool returns text with the URL; model tells user to open it (optionally service calls OS `start` to open browser) |
Key point: in Desktop the iframe cannot reach 127.0.0.1 (CSP connect-src 'none' unless you declare `csp.connectDomains: ['http://127.0.0.1:PORT']`, which Claude may or may not honor and which also requires CORS and exposes the service to the iframe origin). Do NOT rely on it; use the postMessage path in Desktop so the host proxies calls to the stdio MCP server.

Thin adapter (same UI code, two implementations selected at startup):
```ts
interface Host {
  init(): Promise<State>;                         // initial state
  call(op: 'status'|'qr'|'listChats'|'acceptRisk'|'save', args?: unknown): Promise<any>;
  notifyDone?(summary: string): Promise<void>;    // best-effort
  capabilities: { pushContext: boolean };
}
// mcpAppHost: app = new App(...); await app.connect(); call = (op,a)=>app.callServerTool({name:'app_'+op,arguments:a}).then(r=>r.structuredContent)
//   notifyDone = s=>app.updateModelContext({content:[{type:'text',text:s}]})
// httpHost:   call = (op,a)=>fetch('/api/'+op,{method:'POST',headers:{'content-type':'application/json','x-csrf':csrf},body:JSON.stringify(a)}).then(r=>r.json())
// selection: const host = window.__WA_HTTP__ /* injected by the HTTP route */ ? httpHost() : mcpAppHost();
```
Server side: implement each op once as a plain function (`ops.ts`), then expose it twice: as app-only MCP tool (`structuredContent`) and as an HTTP route (JSON). Build the UI once to a single HTML; the HTTP route injects `window.__WA_HTTP__={csrf}` into a copy, while the `ui://` resource serves it with the nonce meta. Avoid the SDK import in the HTTP path by lazy-loading (`await import` inside mcpAppHost) or bundle both (extra ~100 KB is acceptable).
Caveats: the same acceptance, QR and selection logic gets two auth models, so test both; the localhost service must never be reachable by the model without the token (token only shown to the user by the model relaying the URL is itself visible to the model, which is acceptable only because the page additionally needs the user's click plus CSRF/cookie; for the risk-accept step prefer the CLI `accept-risk` or require a typed phrase echoed from the page that the model cannot see). A browser tab, unlike the chat panel, cannot update the model context, so keep a status tool the model can call after the user says they finished.
