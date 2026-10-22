# T12 — Collector host (runs inside the MCP process) + setup ops + local control server

**Model tier:** Sonnet · **Owned files:** `src/host/**`, `test/host/**`, edits to `src/daemon/runner.ts`, `src/daemon/link.ts`, `src/daemon/wa/wa-client.ts` (only the `caught_up` mapping), and their tests.

Read first: `docs/DECISIONS.md` (latest 3 entries), `src/core/service.ts` (contracts: SetupState, SetupOps, CollectorState, HostInfo, auth rules), `src/core/contracts.ts` (ConnectionState now has `caught_up`), `src/core/paths.ts` (`resolveUserPaths`, `defaultDataDir`), `src/daemon/{runner,link,ingest,lock}.ts`, `src/config/selection.ts` (`buildChatRows`, `computeRules`, `writeSelection`), `docs/research/R1-mcp-apps.md` §6 and §9 (auth design).

## What changes
There is no separate daemon for end users anymore. The MCP server process calls `startHost(paths)` at startup. The host:
1. **Lock election:** try `acquireLock(paths.lockFile)`. If it is held by a live pid, become a **follower**: retry every 30 s, and forward setup ops to the holder via `service.json` + control token. On acquiring the lock, become the **holder**.
2. **Holder:** start the control server (see 4), then:
   - if linked (auth `hasCreds()`): start the collector (refactored `runDaemon` logic, embeddable: no signal handlers, no `process.exit`, injected timers/logger);
   - else: stay in setup mode (`needs_accept` or `ready_to_link`).
3. **Setup state machine** implementing `SetupOps`:
   - `acceptRisk` sets `meta.risk_accepted_at`. It needs a user-proof credential (see 4).
   - `startLink` runs `init` steps if needed: keychain key, encrypted DBs, default configs (reuse code from `src/cli/commands/init.ts`, refactored into `src/host/init.ts`, keeping the CLI working). Then it runs linking **in-process**. `linkAccount` currently takes the lock itself; refactor it so the lock-taking wrapper stays for the CLI, and an inner `runLinkSession(dbs, …)` is used by the host, which already holds the lock. The QR string becomes an SVG via `qrcode.toString(qr, { type: 'svg', margin: 1 })` and is stored in memory (never logged, never in a tool result for the model).
   - Pass `chooseChats` that **resolves when `submitSelection` is called** (keep the timeout at about 30 min, then keep the defaults). Steps go `linking → syncing → choose_chats → done`, then the collector starts automatically.
   - `waitForSync(timeoutMs)` resolves when the collector state is `live`, or on timeout.
4. **Control server** (holder only): `node:http` on `127.0.0.1`, port 0 (random). Write `service.json` (`HostInfo`). Routes:
   - `GET /api/health` (no auth) returns `{ ok, version }`.
   - `POST /api/<op>` for each SetupOp. Auth is a control token (keychain, create if missing) or a browser session cookie + `X-CSRF`. `acceptRisk` additionally needs a session **or** a valid panel nonce (`X-Accept-Nonce`).
   - `POST /api/mint-nonce` (control token only, or in-process call) returns `{ nonce }`. Store only a hash. Single use, 10-minute TTL.
   - `POST /api/open-setup` (control token) mints a one-time browser token and **opens the default browser itself** (`explorer.exe "<url>"` on Windows, `open` on macOS, `xdg-open` on Linux) at `/setup?t=…`. It returns `{ opened: true }` without the URL.
   - `GET /setup?t=<one-time>` validates and consumes the token, sets the cookie, then redirects to `/setup`. `GET /setup` (cookie) serves the UI HTML from `dist/ui/setup.html` (built by T13; serve a minimal placeholder if missing). Inject `window.__WA_HTTP__ = { csrf }`.
   - Check `Host` on every request and `Origin` on POSTs. Reject everything else.
   - Remove `service.json` on exit.
5. **Collector freshness:** map Baileys `connection.update.receivedPendingNotifications === true` to the `caught_up` ConnectionState in `src/daemon/wa/wa-client.ts`. The collector state becomes `live` after `caught_up` + 5 s without new messages (or 60 s after open, whichever comes first). Expose `collectorState()` and write `meta.collector_state` + `meta.last_live_at` so followers and `get_status` can read them.
6. **Shutdown:** `stopHost()` closes the collector (no logout), the control server and the DBs, removes `service.json`, and releases the lock. The MCP main calls it on stdin close or SIGTERM.
7. **Follower forwarding:** `createHostClient(paths)` returns a `SetupOps` implementation that calls the holder over HTTP using `service.json` + the control token. `acceptRisk` is forwarded with the nonce. Export `getSetupOps(paths): SetupOps`, which returns the in-process ops if this process is the holder and the HTTP client otherwise.

Read-only guard rules apply. Never log message text, QR strings or tokens.

## Tests
- Two hosts in one test, using a temp data dir, a fake keychain and a fake WaClient factory. One becomes the holder and the other the follower. When the holder stops, the follower takes over (fake timers).
- The full setup flow with a fake client: `needs_accept` → acceptRisk with a session → `startLink` → QR SVG present → open → sync events → `choose_chats` → `submitSelection` → `done` → collector `catching_up` → `caught_up` → `live`.
- Auth:
  - acceptRisk with only the control token returns 403.
  - A replayed nonce returns 403.
  - A wrong `Host` returns 403.
  - A browser one-time token works once.
  - The `open-setup` response does not contain the token.
- `service.json` is written and then removed. Nothing is logged at warn or above with QR or token content.

## Acceptance
`npm run check` + `npm run build` pass. Notes in `docs/notes/T12.md` (exported API: `startHost`, `stopHost`, `getSetupOps`, `createHostClient`, and the route list).
