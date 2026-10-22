# T13 — Setup UI (single-file HTML): risk → QR → sync → chat picker → done

**Model tier:** Sonnet · **Owned files:** `ui/**` (source), `scripts/build-ui.mjs`, `test/ui/**`, the `build:ui` script line in package.json (the orchestrator has added `esbuild` as a devDependency).

Read first: `src/core/service.ts` (SetupState, SetupOps, SelectionSummary), `src/core/contracts.ts` (ChatRow), `docs/research/R1-mcp-apps.md` (§2–3, §7, §9–10: MCP Apps API and the two-host adapter), and `node_modules/@modelcontextprotocol/ext-apps` (README, `dist/src/app.d.ts`; the browser bundle is `dist/src/app-with-deps.js`).

## Two hosts, one UI
- `ui/host.ts` defines `interface Host { init(): Promise<void>; call<K extends SetupOpName>(op, args?): Promise<…>; acceptRisk(): Promise<SetupState>; notifyDone?(summary): Promise<void> }`.
  - **`mcpAppHost`** uses `App` from ext-apps. `call` maps to `app.callServerTool({ name: 'setup_' + op, arguments })` and reads `structuredContent`. `acceptRisk` calls `setup_accept_risk` with `{ nonce: window.__WA_NONCE__ }`, a nonce the server embeds in the HTML. `notifyDone` uses `app.updateModelContext` (best-effort, wrapped in try/catch) with a one-line summary, e.g. "User saved chat selection: 12 groups, 3 direct chats."
  - **`httpHost`** uses `fetch('/api/<op>', { method: 'POST', headers: { 'X-CSRF': window.__WA_HTTP__.csrf, 'Content-Type': 'application/json' }, credentials: 'same-origin' })`.
  - Pick the host at runtime: `window.__WA_HTTP__` set → httpHost, else mcpAppHost.
- The UI must work under the Desktop CSP: no network, inline JS/CSS only, no external fonts. The QR arrives as an SVG string; insert it as a sanitized SVG element (parse with `DOMParser`, allow only svg/path/rect elements).

## Screens (vanilla TS + DOM, no framework; small, accessible, light/dark via `prefers-color-scheme`)
1. **Risk** (`needs_accept`): plain-language warning:
   - unofficial linked device, against WhatsApp's terms, could get the number restricted or banned;
   - other chat members did not consent to an AI reading their messages;
   - message text goes to Anthropic when Claude reads it;
   - wa-bridge is read-only: it never sends, never marks messages as read, and never shows you online;
   - data stays on this computer, encrypted.

   A checkbox "I understand" enables an **"I accept"** button, which calls `host.acceptRisk()`.
2. **Link** (`ready_to_link` → `linking`): a "Connect WhatsApp" button calls `startLink`. Then show the QR (large, high contrast), steps "WhatsApp → Settings → Linked devices → Link a device", and a countdown from `qrExpiresIn`. Poll `state` every 2 s while visible (`document.visibilityState`). Stop polling on terminal states.
3. **Syncing:** a spinner with "Linked as +92… · receiving your chats… (N chats, M messages)". Poll every 2 s.
4. **Choose chats** (`choose_chats`, also reachable from `done` via "Change chats"): load `chatRows`.
   - Tabs: **All / Groups / Direct**, with counts.
   - Search box: case-insensitive, matches the display name and id.
   - Buttons **Select all** / **Select none**, applied to the *visible* (filtered) rows only.
   - Header: "Selected 12 of 88 groups · 3 of 432 direct chats".
   - Each row: checkbox, icon (👥/👤), name (fallback: `+<number>` from the JID, else "Unknown"), members, last activity ("2h ago").
   - **Virtualise the list** (render only visible rows plus a buffer) so 520+ rows stay smooth.
   - Preselected comes from `ChatRow.preselected`.
   - **Save** calls `submitSelection(ids)` and shows the summary: "New groups will be included automatically / not included", and the same for direct chats. A note says turning a chat on later only collects new messages. **Skip** calls `submitSelection(null)`.
5. **Done:** "You're all set. Go back to Claude and ask: *Give me my WhatsApp brief*", plus a "Change chats" link. Call `host.notifyDone(summary)`.
6. **Error** state: show the message plus a "Try again" button.

Use plain language throughout. The user is non-technical.

## Build
`scripts/build-ui.mjs` (esbuild) bundles `ui/main.ts` into one IIFE, inlines it and the CSS into `ui/index.html`, and writes `dist/ui/setup.html`. For the MCP App host, the ext-apps `App` class must be bundled in: import it from `@modelcontextprotocol/ext-apps`, and esbuild resolves the browser build. Add `"build:ui": "node scripts/build-ui.mjs"` and make `npm run build` run `tsc` + `build:ui`. Keep the output under 600 KB.

## Tests (node, no browser)
Put the logic in pure modules and test those: filtering, tab counts, select all/none on visible rows only, display-name fallback, relative time, and the state → screen mapping. Add a test that the build output exists, is a single file, and contains no `http://`/`https://` script or style references.

## Acceptance
`npm run check` + `npm run build` pass. Open `dist/ui/setup.html` in a browser with a mock host (add `ui/dev-mock.ts`, enabled by `?mock=1`, cycling through every screen with fake data, including 520 rows with emoji and Urdu names). Describe what you checked in `docs/notes/T13.md`.
