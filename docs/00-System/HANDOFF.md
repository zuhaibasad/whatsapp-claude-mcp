---
type: handoff
updated: 2026-10-22
---

# HANDOFF: read this first (auto-injected at session start)

## Current state
- **Version 0.2.0 is complete on `main`** and nothing is in flight: no worktrees, all workers (T1–T21) merged.
  - `npm run check`: 380 tests pass.
  - `build:mcpb` and `smoke:mcpb` pass.
  - `scripts/dev/accept-flow.mjs` passes against the packaged build.
  - `scripts/dev/migration-dryrun.mjs` passes: a copy of the real 0.1 Desktop data migrates to schema v3 with a backup.
- **Install file ready:** `C:\tempfolder\wa-bridge-0.2.0.mcpb` (16.9 MB).
- **The user has NOT installed 0.2.0 yet.** 0.1.0 is installed in Claude Desktop, and its data sits in the MSIX-redirected folder. 0.2.0 migrates it to `%USERPROFILE%\.wa-bridge` on first start.
- The README was rewritten (180 lines, visuals in `docs/assets/`).

## What 0.2.0 contains (vs the 0.1.0 the user tested)
- **Data and names:**
  - contact names and LID→phone, activity and unread for every chat;
  - Channels tab and phone search;
  - data dir moved out of AppData, with migration and encrypted backups before upgrades.
- **Tools and briefs:**
  - 7 tools;
  - one `whatsapp_brief` call that waits for sync;
  - the picker opens for "add a chat";
  - a permissions tip at the end of onboarding.
- **Message quality:** an untrusted-content notice, quoted-reply text, `context_before`, location and contact cards.
- **Connection health:** sleep/resume and stall detection, health meta, proxy support.
- **Lifecycle:**
  - Disconnect in the panel, needing user proof;
  - per-chat notes in `departments.yaml`;
  - `whatsapp_status {diagnose:true}` and `wa-bridge doctor`.

## Next steps
1. **The user tests 0.2.0 in Claude Desktop.**
   1. Settings → Extensions → install `C:\tempfolder\wa-bridge-0.2.0.mcpb` over 0.1.0. It should keep the link; if not, re-link.
   2. "Give me my WhatsApp brief". It should make one tool call.
   3. "Add a chat". The picker should open: check the Channels tab, names and numbers, sort by recent or unread, and phone search.
   4. Open the Disconnect screen and **cancel** it.
   5. "Run a WhatsApp diagnose".
   6. Set the tools to "Always allow" (Settings → Extensions).
2. Fix whatever the test finds, inline and small.
3. After a fresh link, names and activity fill in for all chats; otherwise they fill in gradually.

## Waiting on the user (decisions)
- **Licensing blocks any PUBLIC `.mcpb` release.** `baileys` → `libsignal` 6.0.0 is **GPL-3.0**, and it is bundled in the `.mcpb`. See `docs/LICENSE_OPTIONS.md`. Private use by friends is less affected.
- Review the README and `docs/GITHUB_SEO.md` (repo name, topics). The clone URL in the README is a placeholder repo name.

## Gotchas
- **Keychain:** keep `project-0a3a77d63a17e508` (the 0.1 Desktop key; legacy path `%LOCALAPPDATA%\wa-bridge`; it plus its service-token are the user's real data) and `project-ad81168d44ced01f` (the dev project `C:\tempfolder\wa-bridge`). Test runs leave stray `project-*` entries, so remove them with `cmdkey /delete:<target>`.
- **Shell:** Git Bash eats backslashes. Use Edit/Write or `path.join`. Use `cmd //c` for `cmdkey` and `mklink`.
- **Read-only guard:** any identifier or string equal to a WhatsApp write-API name fails the build.
- **Claude Desktop:** MSIX redirects *new* AppData folders, and child processes are killed. Panels and app-only tools work.
- **Token economy:** see CLAUDE.md. Do small fixes inline and use at most 1–2 workers.

## Last session
[[2026-10-21-22-build-to-0.2.0]]
