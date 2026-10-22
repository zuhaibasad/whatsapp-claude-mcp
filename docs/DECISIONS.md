# Decisions log

Newest first. Each entry: date, decision, reason, alternatives.

## 2026-10-21 — Phase 1 implementation decisions
- **Data location:** one `.wa-bridge/` per project folder (the brief's default). The keychain entry is per project path (`project-<sha256 prefix>`).
- **Baileys logger capped at `warn`.** Baileys' debug/trace output can contain raw frames, and our own logs carry ids and event names only.
- **Excluded chats are never stored.** Only a chat row with `included=0` is kept, so you can see the chat and switch it on. An existing chat keeps its `included` flag until `config.yaml` changes; the daemon re-applies the filter within about 30 s.
- **Deleted messages lose their text** (`text=NULL`) and drop out of search.
- **Daemon stops instead of looping** on `logged_out`, `forbidden`, `replaced`, `bad_session`, or when WhatsApp asks for a new QR. Only `link` ever shows a QR.
- **`init --accept`** works only with env `WA_BRIDGE_ACCEPT_RISK="I accept"`, so a script or agent cannot skip the warning by accident.
- **Built with agents:** an orchestrator (Opus) plus Sonnet/Haiku workers in git worktrees. The protocol is in `docs/AGENTS.md` and the task specs in `docs/tasks/`.

## 2026-10-21 — `unlink` may call `logout()` (approved by user)
- **Decision:** `logout()` is the only write call to WhatsApp that is allowed. It runs only from `wa-bridge unlink`, after you type a confirmation. The read-only guard allowlists it by name, and every other send-type API still fails the build.
- **Why:** it removes the device from *Linked devices* on the phone, as the brief asks. It ends the session and sends no message, receipt or presence update.
- **Rejected:** a local-only unlink, where you would log the device out by hand on your phone.

## 2026-10-21 — WhatsApp library: Baileys (`baileys` 7.0.0-rc14, pinned)
- **Why:** connects over WebSocket directly (no headless Chromium), MIT, active (rc14 on 2026-07-29). Exposes the options we need for read-only behavior: `markOnlineOnConnect`, `syncFullHistory`, `shouldSyncHistoryMessage`. Read receipts are sent only through an explicit `readMessages` call, which our guard bans.
- **Watch out:** the defaults are `markOnlineOnConnect: true` and `syncFullHistory: true`. We override both. Versions before 7.0.0-rc12 have CVE-2026-48063 (message spoofing).
- **Rejected:** `whatsapp-web.js` 1.34.7 (Apache-2.0), because it needs Puppeteer/Chromium and is heavier and more fragile.

## 2026-10-21 — Encrypted store: `better-sqlite3-multiple-ciphers` 13.x, SQLCipher v4 profile
- **Why:** encrypts the whole file, including the FTS5 index and metadata, and ships prebuilds for win/mac/linux. Smoke-tested on Windows 11 / Node 24: FTS5 works, no plaintext in the file, and opening without the key fails with `SQLITE_NOTADB`.
- **Rejected:** field-level libsodium encryption, because it leaks metadata and cannot work with FTS5.

## 2026-10-21 — Keychain: `@napi-rs/keyring` 2.x
- **Why:** maintained (Rust keyring crate via N-API) and covers macOS Keychain, Windows Credential Manager and libsecret. Round-trip tested on Windows.
- **Rejected:** `keytar`, because it is archived.

## 2026-10-21 — WhatsApp session stored in encrypted `auth.db`, not files
- **Why:** Baileys' `useMultiFileAuthState` writes plaintext JSON keys, and the brief requires the session to be encrypted at rest.

## 2026-10-21 — MCP: `@modelcontextprotocol/server` 2.x (stdio)
- **Why:** current stable official SDK. `@modelcontextprotocol/sdk` 1.x is the fallback.

## 2026-10-22 — Targets: Claude Desktop + Claude Code (IDE/desktop/CLI); no claude.ai web
- **Why:** claude.ai web can only reach remote tools, which would expose WhatsApp data to the internet and break the local-only rule. Desktop and Claude Code run local tools.
- **Consequence:** the setup UI is a local web page served by the service (works everywhere), plus the same UI as an in-chat MCP App panel in Desktop. No terminal for end users. Data moves to a per-user data dir.
- **Premium ideas** (voice notes, call items, call transcription, claude.ai via tunnel) are on hold in `docs/ROADMAP.md`.

## 2026-10-22 — No background service: the collector runs only while Claude is open
- **Decision (user):** no Task Scheduler, no startup entry, no long-running service. The wa-bridge MCP server process, which Claude Desktop or Claude Code keeps running for the session, also hosts the WhatsApp collector.
- **Why:** briefs only run while Claude is open anyway. On start, the collector reconnects and WhatsApp delivers the messages that arrived while it was offline. Packaging becomes much simpler: no runtime copied to disk, no scheduler, no update dance.
- **One connection rule:** several MCP processes may run at once (Desktop plus Claude Code). The one that holds the lock (`daemon.lock`) runs the collector. The others only read the store and forward setup actions to the holder over 127.0.0.1. They retry the lock every 30 s, so one takes over when the holder exits.
- **Code boundary unchanged:** only `src/daemon/wa/**` imports Baileys. The MCP *tools* still only read the store. The collector is a co-hosted component started by the MCP entry point.
- **Freshness:** after connect, the collector reports `catching_up` until Baileys signals `receivedPendingNotifications` (plus a short quiet period). Briefs wait for that, with a timeout.
- **Risk:** if Claude is not opened for a long time, WhatsApp may stop holding offline messages or log the linked device out (period unverified, roughly weeks). `get_status` warns, and re-linking is a one-click setup.
- **Supersedes:** the R2 recommendation of a bundled node.exe + Task Scheduler service.

## 2026-10-22 — Images: download + local OCR (tesseract.js), text to Claude instead of pixels
- **Decision (user):** company groups share bills and payment screenshots. Images in *selected* chats are downloaded, stored in the encrypted `store.db` (`media` table, schema v4), read on this PC with tesseract.js (WASM, English `best_int`), and pattern-matched into fields (amount, currency, date, reference, bank). Tools return the OCR text and fields; the picture itself only on request (`whatsapp_read` action `media`, `include_image`).
- **Why:** an image costs about 1–1.5k tokens, OCR text a few dozen. Tesseract is pure JS/WASM (Apache-2.0), with no native binaries or child processes (MSIX-safe), and adds about 6 MB to the `.mcpb`.
- **Read-only holds:** `downloadContentFromMessage` (HTTP fetch + decrypt, in `src/daemon/wa/media-download.ts`) only. `downloadMediaMessage` stays denied because it can call `updateMediaMessage` (a re-upload request to the phone). Expired media stays `expired`; it is never re-requested.
- **Limits:** max 10 MB per image; `media_max_mb` (default 500) caps stored bytes, oldest dropped first, OCR text kept; retention purges media with messages. Config: `media_download`, `media_ocr`, `media_max_mb`. Media download does not use the proxy yet.
- **Not yet:** PDFs, Urdu OCR, images from before 0.3 (no stored keys).

## 2026-10-22 — Product renamed: ChatAI for WhatsApp (slug `chatai`)
- **Decision (user):** product name "ChatAI for WhatsApp", with a new logo (`docs/assets/logo.svg`, `packaging/mcpb/icon.png`). The GitHub repo stays `whatsapp-claude-mcp`, and the local folder stays `wa-bridge`.
- **Changed everywhere** (no users yet, the user's phone is already unlinked): CLI `chatai`, extension id `chatai`, MCP server name, data folder `~/.chatai`, keychain service `chatai`, env vars `CHATAI_*`, `ui://chatai/...`.
- **Kept:** the KDF salt `wa-bridge/v1` (invisible; changing it would change derived keys), the WhatsApp device name "Desktop" (needed for full history sync), tool names `whatsapp_*`, skill folders `skills/wa-*`. Old session logs and task specs keep the old name as history.
- **Trademark:** "X for WhatsApp" is the descriptive form. WhatsApp's green and phone mark are not used.
