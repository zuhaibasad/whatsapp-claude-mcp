# Changelog

All notable changes. Versions follow [semver](https://semver.org/). Dates are release-build dates.

## 0.4.3 (2026-11-11)

### Added
- **Add new chats automatically.** `auto_add_new_groups` and `auto_add_new_direct_chats` in `config.yaml` (both off by default). When on, saving a chat selection keeps that chat type switched on and puts every unticked chat on the denylist, so a chat that appears later is read without picking it. Pick your chats again after turning it on.

### Fixed
- **The connector still exited after an "ocr failed" line (the real cause).** tesseract.js 7.0.0 always loads its full (non-LSTM) engine in Node, and the bundle had removed those files, so every image failed with "Cannot find module tesseract-core-relaxedsimd". The failure was then thrown inside tesseract's worker listener as an uncaught error, which killed the whole connector. The engine files are shipped again, OCR errors are now handled, and the bundle smoke test runs OCR from the packaged build.

## 0.4.2 (2026-11-10)

### Fixed
- **The connector exited a few seconds after starting** inside Claude Desktop, every time, right after an "ocr failed" line. Image reading (OCR) is optional, so it can no longer take the connector down: a mark is written before each OCR call, and if the previous run died inside OCR, OCR is paused for 3 days (images are still saved). Three failures in a row also switch OCR off until the next start. The log now records the OCR error text (never the image text).

## 0.4.1 (2026-11-10)

### Added
- **Old-data cleanup, asked with a real OS dialog.** Before setup, ChatAI looks for saved data from earlier installs (the `wa-bridge` name, the 0.1 `%LOCALAPPDATA%` folder, a store whose keychain key is gone) and asks "delete it?" in a native Windows/macOS dialog the model cannot answer. Yes removes only ChatAI's own files and keychain keys; No is remembered.
- **You choose where the data lives.** On first setup a dialog offers the default folder or any folder/drive. The choice is kept in `location.json` next to the default folder; changing it needs a Claude restart.

### Fixed
- Setup failed with "wrong key" when the data folder still held a database from an earlier install and its keychain key had been deleted (e.g. after replacing an older version). Setup now offers to remove it, and refuses with a clear message instead of creating a key that cannot open it.
- A stale `daemon.lock` left from before a reboot could look "held" when Windows reused its process id, so the new connector waited forever as a follower. A lock older than the last boot is now ignored.

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
