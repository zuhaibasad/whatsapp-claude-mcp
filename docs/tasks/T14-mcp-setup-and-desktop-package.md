# T14 — MCP: setup tools, collector hosting, conversational chat control + Claude Desktop package (.mcpb)

**Model tier:** Sonnet · **Owned files:** `src/mcp/**`, `test/mcp/**`, `packaging/**`, `scripts/build-mcpb.mjs`, the `build:mcpb` script line in package.json.

Read first: `src/core/service.ts`, `docs/tasks/T12-collector-host.md` and `T13-setup-ui.md` (built in parallel; use their APIs exactly as specified there), `src/mcp/*` (existing 12 tools), `docs/research/R1-mcp-apps.md`, `docs/research/R2-packaging.md`, `docs/research/R3-desktop-probe.md`, and `skills/*/SKILL.md`.

## MCP server changes
1. **Data dir:** the default is `resolveUserPaths()` (`%LOCALAPPDATA%\wa-bridge`). Keep `--project <dir>` for development (`resolvePaths`). Also accept `--data-dir <dir>`.
2. **Main:** start the host (`startHost(paths)` from `src/host/index.js`, T12) **without blocking** the MCP handshake. Stop it on stdin end, SIGTERM or SIGINT. The MCP server never touches Baileys directly.
3. **Setup tools.** Use `registerAppTool`/`registerAppResource` from `@modelcontextprotocol/ext-apps/server` (installed by the orchestrator).
   - `open_setup` (model-visible): "Open the WhatsApp setup panel (link account, choose chats). Use when the user wants to set up, re-link or change which chats wa-bridge reads." Its `_meta.ui.resourceUri` is `ui://wa-bridge/setup.html`.
     - The text result says the panel is shown, and to wait for the user.
     - **Fallback for clients without MCP Apps** (Claude Code): detect via client capabilities (the `io.modelcontextprotocol/ui` extension, see R1 §8). If unsupported, call the host's `open-setup` route, which opens the browser itself, and return "I opened the setup page in your browser."
     - Never return a URL with a token.
   - `ui://wa-bridge/setup.html` resource: serve `dist/ui/setup.html` with `window.__WA_NONCE__` injected. Mint the nonce per read via the host. The nonce must never appear in any tool result.
   - App-only tools (`_meta.ui.visibility: ['app']`): `setup_state`, `setup_accept_risk {nonce}`, `setup_start_link`, `setup_cancel_link`, `setup_chat_rows`, `setup_submit_selection {selectedIds|null}`. They call `getSetupOps(paths)`. **List them only when the client supports MCP Apps.** In other clients they must not be registered at all, because Claude Code ignores visibility.
     - `setup_state` must **omit `qrSvg`** in its text `content` and put it only in `structuredContent`. Assume app-tool results may reach the transcript: minimise them.
4. **Conversational control (model-visible):**
   - `set_chat_inclusion {include?: string[], exclude?: string[]}`: resolves names/ids like the CLI (reuse `src/cli/commands/select.ts` logic; move the shared resolver into `src/config/selection.ts` if needed), writes the selection and returns what changed.
   - `wait_for_sync {timeout_seconds?: number = 60}` calls `waitForSync`.
   - Extend `get_status` with `collector` state, `last_live_at`, and a warning when not linked ("say: set up WhatsApp").
5. **Server `instructions`:** a short block (≤ 25 lines) carrying the essential skill guidance for Claude Desktop, which has no SKILL.md files: read-only rules, call `get_status` first and `wait_for_sync` before briefs, how to do a daily brief, mentions and exports, uncertainty and refs. Also add **MCP prompts** `daily_brief`, `mentions` and `department_report`, built from the skills' content (Desktop shows prompts in the + menu).

## Claude Desktop package
- `packaging/mcpb/manifest.json` (manifest_version 0.3):
  - `server.type: "node"`, `entry_point: "dist/mcp/main.js"`, `mcp_config.command: "node"`, `args: ["${__dirname}/dist/mcp/main.js"]`. Desktop's built-in Node works with our N-API modules (R3).
  - `compatibility.platforms: ["win32"]`.
  - Tools list. Display name "WhatsApp Bridge (read-only)". Description with the risk note.
- `scripts/build-mcpb.mjs`:
  - `npm run build`, then stage `dist/`, `templates/`, `package.json` and a **production-only, pruned** `node_modules` (`npm ci --omit=dev` into the stage dir; remove non-win32-x64 prebuilds, `deps/`, `src/`, docs and tests, as in R2 §2) into `build/mcpb/`.
  - Then `npx @anthropic-ai/mcpb pack build/mcpb build/wa-bridge-<version>.mcpb`. Add `@anthropic-ai/mcpb` as a devDependency via a NEED (the orchestrator installs it).
  - Print the size. Target: < 25 MB.
- Smoke test script `scripts/smoke-mcpb.mjs`: unpack to a temp folder, run `node dist/mcp/main.js --data-dir <tmp>` over stdio, and check initialize, tools/list (includes `open_setup`) and resources/read of the setup UI. No WhatsApp connection: the host stays in `needs_accept`.

## Tests
- Tool registration with and without the UI capability (app-only tools hidden without it).
- Nonce never present in any tool result.
- `open_setup` fallback calls host open-setup and returns no URL.
- `set_chat_inclusion` resolution.
- `get_status` includes collector state.
- `instructions` present.
- Prompts listed.

## Acceptance
`npm run check`, `npm run build` and `npm run build:mcpb` pass, and the smoke script passes. Notes in `docs/notes/T14.md`, including the exact manual Desktop test steps for the user.
