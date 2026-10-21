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
