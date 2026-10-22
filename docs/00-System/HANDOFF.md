---
type: handoff
updated: 2026-10-22
---

# HANDOFF: read this first (auto-injected at session start)

## Current state
- **Product: ChatAI for WhatsApp, v0.3.0, committed on `main`.**
  - Slug `chatai` everywhere: CLI, extension id, `~/.chatai`, keychain service, `CHATAI_*` env vars.
  - The repo/folder name stays `wa-bridge` and the GitHub repo stays `whatsapp-claude-mcp`.
- `npm run check`: 396 tests pass. `build:mcpb` (23.7 MB) and `smoke:mcpb` pass. OCR works from the packaged build.
- **Install file:** `C:\tempfolder\chatai-0.3.0.mcpb`. Older `wa-bridge-0.1/0.2.mcpb` files sit next to it and are obsolete.
- **Nobody runs it right now.** The user unlinked their phone, and every keychain entry was deleted. A friend tested 0.2.0 (it worked; images were not read) and has not got 0.3.0 yet.
- **Not pushed:** local `main` is ahead of `origin/main`. GitHub has a **draft** release v0.3.0 (`chatai-0.3.0.mcpb` attached), targeting `main`.

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
3. Push `main`, then publish the draft once licensing is decided.
4. Later: PDF bills, Urdu OCR (`urd` traineddata), proxy support for media downloads.

## Waiting on the user (decisions)
- **Licensing blocks any PUBLIC release:** `baileys` → `libsignal` 6.0.0 is **GPL-3.0** and bundled. See `docs/LICENSE_OPTIONS.md`.
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
