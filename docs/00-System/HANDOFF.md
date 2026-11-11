---
type: handoff
updated: 2026-11-11
---

# HANDOFF: read this first (auto-injected at session start)

## 0.5.0 (committed 2026-11-11, NOT pushed, NOT released): opt-in private messages
- **Install file:** `C:\tempfolder\chatai-0.5.0-windows.mcpb`. Real send NOT yet tested against WhatsApp: test on the user's own PC with a consenting contact before giving it to the friend (the friend should get 0.4.3 until then).
- `allow_sending: true` (default false, restart Claude) lists `whatsapp_send_direct {ref, text}`. Gate in `HolderCore.sendDirect`: author of stored message only, direct JIDs only, ≤1000 chars, 20 s gap, 30/day (meta `direct_sent_today`), native dialog 90 s (env-var text, verified on Windows with hostile text + timeout). Allowlists the recipient's phone + LID chat after sending.
- Guard: `ALLOWED_EXCEPTION_FUNCTIONS` map (logout→unlink, sendMessage→sendDirectText). Docs updated: CLAUDE.md, README, DECISIONS, manifest, instructions.
- Known gaps: our own sent text is not stored (emitOwnEvents false), so Claude sees only the reply; macOS dialog path untested; no setup-UI switch.
- Watch for: (a) sending to a bare `@lid` (poster with no phone mapping) is unverified in Baileys rc14, and the dialog then shows only a name; (b) FIXED: sendDirect calls `collector.reloadConfig()` right after allowlisting, so a quick reply is no longer dropped by `onChats` using the old config (test: "a reply arriving right after the send is kept"). (c) With sending on, tools/list is over the 6000-char budget (test checks the default only).

## 0.4.3 (committed 2026-11-11, NOT pushed, NOT released on GitHub)
- **Install file:** `C:\tempfolder\chatai-0.4.3-windows.mcpb` (19.4 MB, smoke incl. packaged OCR passes). For the user's friend's Windows PC. macOS bundle not rebuilt.
- **Crash root cause (0.4.2 still crashed):** tesseract.js 7.0.0 node `getCore` compares the `lstmOnly` boolean to OEM numbers, so it ALWAYS loads non-lstm cores; build pruned them. The failure then threw inside tesseract's worker listener (no `errorHandler`), an uncaught error that killed the MCP. Fixed both; smoke now runs OCR from the bundle.
- **Desktop logs now live in `%LOCALAPPDATA%\Claude\logs`** (`mcp-server-ChatAI for WhatsApp.log`); our own log is `~/.chatai/daemon.log`.
- **New: `auto_add_new_groups` / `auto_add_new_direct_chats`** (default off). `computeRules` forces the type default on and denylists unticked chats, so chats first seen later are included. The user must re-pick chats after turning it on. No setup-UI toggle yet (possible next step).
- Dev machine: user is linked and syncing on the broken 0.4.2; reinstall 0.4.3.

## Current state
- **Product: ChatAI for WhatsApp, v0.3.0, committed on `main`.**
  - Slug `chatai` everywhere: CLI, extension id, `~/.chatai`, keychain service, `CHATAI_*` env vars.
  - The repo/folder name stays `wa-bridge` and the GitHub repo stays `whatsapp-claude-mcp`.
- `npm run check`: 396 tests pass. `build:mcpb` (23.7 MB) and `smoke:mcpb` pass. OCR works from the packaged build.
- **Install file:** `C:\tempfolder\chatai-0.3.0.mcpb`. Older `wa-bridge-0.1/0.2.mcpb` files sit next to it and are obsolete.
- **Nobody runs it right now.** The user unlinked their phone, and every keychain entry was deleted. A friend tested 0.2.0 (it worked; images were not read) and has not got 0.3.0 yet.
- **Released:** v0.4.0 is PUBLISHED on GitHub with `chatai-0.4.0-windows.mcpb` and `chatai-0.4.0-macos.mcpb`. CI (Windows + macOS) is green. Not yet tested in a real Claude Desktop on a Mac.

## 0.4.1 (built 2026-11-10, NOT committed, NOT released)
- User reported: after removing 0.2 and installing 0.4, Claude Desktop could not run the connector. Exact launch error was never seen (no Desktop log on the dev machine after 09-14), so ask for `mcp-server-ChatAI*.log` if it persists.
- Found and fixed: `~/.chatai` held `store.db`/`auth.db` with the keychain key deleted. `initDataFiles` made a NEW key over the old DB, so setup died with "wrong key". Now it throws a clear message, and `whatsapp_setup` runs `src/host/preflight.ts` first.
- New: `leftovers.ts` (scan/remove old data + keychain keys, fixed file-name list only), `dialog.ts` (native Windows/macOS confirm + folder picker, so the model cannot answer), `preflight.ts` (cleanup question, then data-folder question), `location.json` pointer in the anchor folder (`paths.ts`: `anchorDataDir`, `readLocation`, `writeLocation`). Lock older than last boot is now stale (pid reuse).
- Dialogs are untested on real screens (PowerShell scripts parse OK; logic tested with fake dialogs, 14 tests). Mac `osascript` path never run.
- `npm run check` 410 pass; `build/chatai-0.4.1-windows.mcpb` built and smoke-passed. macOS bundle not rebuilt.
- Cleanup of the current dev machine's `~/.chatai` happens through the dialog on first `whatsapp_setup`, not by hand.

## What 0.3.0 adds (vs 0.2.0)
- **Images in selected chats:**
  - downloaded with `downloadContentFromMessage` only, never a re-upload request;
  - stored in the encrypted `store.db` (schema v4 `media` table);
  - read locally by tesseract.js (English `best_int`, WASM).
- **Fields** (amount, currency, date, reference, bank) come from pattern matching in `src/daemon/ocr-fields.ts`.
- **Tool output:**
  - each message has an `image` field: OCR summary and fields;
  - `whatsapp_read` action `media` lists images or returns full text by refs;
  - `include_image` attaches the picture, only when asked;
  - search also matches image text.
- **Config:** `media_download`, `media_ocr`, `media_max_mb` (default 500; oldest bytes dropped, OCR text kept).
- **Rebrand:** logo `docs/assets/logo.svg`, `packaging/mcpb/icon.png`, indigo UI, regenerated README visuals and screenshots.

## Next steps
1. **The user/friend tests 0.3.0 in Claude Desktop.** Remove the old WhatsApp Bridge extension first, since the extension id changed.
   1. Set up WhatsApp.
   2. Wait for a bill or payment screenshot in a selected group.
   3. Ask for the brief, then "total payments this week".
   4. Check the `image.fields` quality on real bills. Ask the user for blurred samples to tune `ocr-fields.ts`.
2. **Phone / claude.ai, with no server:**
   - test whether **Cowork** in Desktop sees the ChatAI extension;
   - if it does, try **Dispatch** from the phone;
   - otherwise try Claude Code **Remote Control** (`claude remote-control`).
   - Only if both fail: an HTTP transport plus a self-deployable relay. That plan is in the 2026-10-22 session log.
3. Test the macOS bundle in a real Claude Desktop on a Mac.
4. Later: PDF bills, Urdu OCR (`urd` traineddata), proxy support for media downloads.

## Waiting on the user (decisions)
- **License:** source MIT; bundles distributed under GPL-3.0 (libsignal), stated in NOTICE and README. Decided 2026-10-22.
- **Whether to push `main`** (not done, not yet asked).

## Gotchas
- **Read-only guard:**
  - only `src/daemon/wa/**` may import baileys;
  - `downloadMediaMessage`/`updateMediaMessage` stay denied;
  - any write-API name fails the build.
- **Tool surface budget:** `tools/list` must stay under 6000 chars (`test/mcp/surface.test.ts`). It is at about 5990 now, so trim descriptions before adding.
- **Kept on purpose:**
  - KDF salt `wa-bridge/v1`;
  - WhatsApp device name "Desktop" (needed for full history sync);
  - tool names `whatsapp_*`, skill folders `skills/wa-*`.
- **Screenshots:** `npm run build`, then headless Edge on `dist/ui/setup.html?mock=1&step=<step>`, 760x900, cropped to 612.
  - `--virtual-time-budget=4000` is needed for the page to render.
  - `preferredColorScheme=0` renders DARK and `1` renders light (inverted from what you'd expect).
- **Shell:**
  - Git Bash eats backslashes; use Edit/Write or a script file for multi-line node edits.
  - Never `cd` into `build/mcpb` (it locks the folder and `build:mcpb` fails with EPERM).
- **Keychain:** test runs leave stray `project-*` entries; remove them with `cmd //c "cmdkey /delete:<target>"`.
- **Claude Desktop:** MSIX redirects *new* AppData folders and kills child processes. Tesseract runs in worker_threads, which is fine.
- **Token economy:** see CLAUDE.md. Do small fixes inline; use at most 1–2 workers.

## Last session
[[2026-10-22-0.3.0-ocr-and-chatai]]
