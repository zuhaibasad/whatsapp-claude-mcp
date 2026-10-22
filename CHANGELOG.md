# Changelog

All notable changes. Versions follow [semver](https://semver.org/). Dates are release-build dates.

## 0.4.0 (2026-10-22)

### Added
- **macOS support** (Apple Silicon and Intel): a separate `chatai-<version>-macos.mcpb`. Data lives in `~/Library/Application Support/chatai`, and the key in the macOS Keychain. The Windows file is now `chatai-<version>-windows.mcpb`.
- CI on Windows and macOS: tests, then build and smoke-test each bundle.

### Changed
- Smaller bundles (Windows 23.7 → 15.4 MB): the image library `sharp` is no longer shipped. WhatsApp's library uses it only to make thumbnails when sending, which ChatAI never does.
- Requires Node.js 24 when run from source (Claude Code). Claude Desktop is unaffected.

## 0.3.0 (2026-10-22)

### Added
- **Bills and payment screenshots.** Images in selected chats are downloaded, stored encrypted, and read on your PC with tesseract.js (local OCR). Claude receives the text plus the amount, currency, date, reference and bank, not the picture.
- `whatsapp_read` action `media`: list images by chat and time, or get the full text by message ref. `include_image` attaches the picture only when asked.
- Search also matches text inside images.
- Settings `media_download`, `media_ocr` and `media_max_mb`.

### Changed
- **New name: ChatAI for WhatsApp** (was wa-bridge), with a new logo and colours. The CLI is now `chatai`, the data folder `%USERPROFILE%\.chatai`, and environment variables `CHATAI_*`. Claude Desktop sees it as a new extension: remove "WhatsApp Bridge" before installing.
- License changed from Apache-2.0 to **MIT**.
- Database schema v4 (a backup is made before the upgrade).

## 0.2.0 (2026-10-22)

### Added
- Contact names and phone numbers for every chat, activity and unread counts, a Channels tab and phone search in the chat picker.
- One-call `whatsapp_brief` that waits for sync. The picker opens for "add a chat".
- Quoted-reply text, earlier context in briefs, and location and contact cards.
- Connection health: sleep/resume and stall detection, proxy support.
- Disconnect in the setup panel, per-chat notes (`departments.yaml`), `whatsapp_status {diagnose: true}` and `doctor`.
- Encrypted backups before database upgrades.

### Changed
- Data folder moved out of AppData (migrated automatically).
- Seven model-visible tools instead of many small ones.

## 0.1.0 (2026-10-21)

- First working version: link WhatsApp as a read-only companion device, encrypted local store, daily brief, mentions, search, follow-up items and export, and a setup panel inside Claude Desktop.
