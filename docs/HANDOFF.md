# Handoff — state at end of session (2026-10-22 evening)

Read this first, then `docs/AGENTS.md` (how workers run), `docs/DECISIONS.md` (why things are the way they are) and `docs/PLAN.md` §11.

## Product in one paragraph
wa-bridge gives Claude **read-only** access to the user's own WhatsApp chats.
- **Targets:** Claude Desktop (main; `.mcpb` extension with an in-chat setup panel), plus Claude Code and the CLI. claude.ai web is **out**, because it cannot reach local tools without exposing data.
- **No background service:** the WhatsApp collector runs **inside the MCP server process only while Claude is open**, and catches up on start. Lock election means one connection, even with Desktop and Code open together.
- **Data:** an encrypted SQLite store (SQLCipher), with the key in the OS keychain. On Windows the data lives in `%USERPROFILE%\.wa-bridge`, **not AppData**, because Claude Desktop's MSIX redirects new AppData folders.
- **Tools:** 7 model-visible tools (`whatsapp_brief/status/read/items/mark_reviewed/setup/choose_chats`), plus hidden `setup_*` tools for the panel.

## Where things stand
- **`main`** (last orchestrator commit `09f1661` + user commit `038e5e8` "adding license and readme"): all of T1–T17 merged and integrated. `npm run check` was green at 327 tests (re-run it). The 0.2.0 `.mcpb` built and smoke-tested before the README commit.
- **The user tested 0.1.0 in Claude Desktop:** linking, catch-up after restart, briefs and critical items all worked. Their feedback drove T15–T17 (names, recency, channels, fewer tools, picker-first) and the data-dir move.
- **0.2.0 has NOT been installed by the user yet.** The migration from the 0.1.0 Desktop sandbox folder was dry-run on a copy of the real data and passed (`scripts/dev/migration-dryrun.mjs`).

## In flight when the session ended (git worktrees under `.claude/worktrees/`)
| Task | Spec | Branch | Status |
|---|---|---|---|
| T18 content/context | `docs/tasks/T18-content-context.md` | merged | **Merged** (schema v3). |
| T19 connection health + proxy | `docs/tasks/T19-connection-health.md` | merged | **Merged**. T20 must pass `onFrame` in the host default factory. |
| T20 lifecycle (Disconnect in panel with user proof, chat notes, diagnose / `wa-bridge doctor`, backups before migrations) | `docs/tasks/T20-lifecycle-ops.md` | `worktree-agent-a48482ff6c0d18f69` | Same. |
| T21 README rewrite (visual, short, SEO) + licence options | in the agent prompt; outputs `README.md`, `docs/assets/**`, `docs/GITHUB_SEO.md`, `docs/LICENSE_OPTIONS.md` | `worktree-agent-a77916063915c271c` | Started at session end. |

**How to recover:**
1. `git worktree list`
2. For each branch, `git log main..<branch>` to see what was committed, and check the uncommitted changes inside the worktree.
3. If a worker is not reachable any more, start a new Sonnet worker on the same spec in a fresh worktree. Tell it to first `git merge <old-branch>` (or copy its uncommitted files) and continue.
4. The board `.agents/BOARD.md` shows START/DONE/INFO posts.

## Next steps (agreed with the user)
1. Finish and merge T18, T19 and T20, then T21.
   - **Expected conflicts:** `src/mcp/server.ts` (T18 formatting call sites vs T20 tools), `src/mcp/instructions.ts` (both add a line), `src/core/service.ts` (T20 makes `disconnect`/`diagnose` required), `src/core/constants.ts` (T18 bumps `SCHEMA_VERSION` to 3), `ui/logic.ts` (T20 removes the `UiOpName` exclusions), and the host's default WaClient factory must pass T19's `onFrame`.
2. **Integration checks:**
   - `npm run check`, `npm run build`, `npm run build:mcpb`, `npm run smoke:mcpb`.
   - `scripts/dev/accept-flow.mjs` against the unpacked `.mcpb` (it should cover disconnect proof too: add a check that disconnect with the control token is refused).
   - `scripts/dev/migration-dryrun.mjs` again (it now includes the v2→v3 upgrade and backups).
   - Clean up stray test keychain entries (`cmdkey /list | grep wa-bridge`). Keep `project-0a3a77d63a17e508` (the user's Desktop key; its legacy path is `%LOCALAPPDATA%\wa-bridge`) and `project-ad81168d44ced01f` (the dev project `C:\tempfolder\wa-bridge`).
3. Copy `build/wa-bridge-0.2.0.mcpb` to `C:\tempfolder\` and give the user Desktop test steps:
   - install over 0.1.0;
   - "Set up WhatsApp" / "add a chat" opens the picker (check Channels tab, names, phone search, recency);
   - permissions tip;
   - brief with a single `whatsapp_brief` call;
   - Disconnect screen (cancel it);
   - `whatsapp_status` diagnose.

   A fresh link fills in names and activity for all old chats at once. Without one, they fill in gradually.
4. Review the T21 README and licence recommendation with the user. The licence change is the user's decision.

## Gotchas learned
- **Shell:** Git Bash eats backslashes in `node -e`, heredocs into JS template strings, and `sed`. For Windows paths and regexes, use the Write/Edit tools or `path.join`. `cmd //c` is needed for `cmdkey` and `mklink`.
- **Worker worktrees:** Write/Edit can't reach outside the worktree, but shell appends to `.agents/BOARD.md` work. Notes go to `docs/notes/<task>.md` in the branch. Before `git worktree remove`, remove the `node_modules` junction with `cmd //c rmdir`.
- **Read-only guard** (`test/guard/`): **any identifier or string** equal to a WhatsApp write-API name fails the build. `logout` is allowed only inside `unlink` in `src/daemon/wa/wa-client.ts`.
- **Packaging pruning:** a too-broad regex once deleted `baileys/lib/Utils/history.js`. The smoke test catches this now. Keep LICENSE files.
- **Claude Desktop facts** (R3 + addendum): Electron node v24, CWD `system32`; child processes are killed; panels and app-only tools work; MSIX redirects *new* AppData folders.
- **Session limits:** many parallel Sonnet workers can hit the account's session limit. Resume them with SendMessage after the reset rather than restarting.

## Held for later (user decision)
Voice-note transcription, missed-call items, call transcription (research only), claude.ai via tunnel, macOS/Linux, an n8n webhook for unattended CRM push, and per-department routing to Notion/ClickUp via Claude connectors. See `docs/ROADMAP.md`.
