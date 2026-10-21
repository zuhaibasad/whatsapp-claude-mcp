# Multi-agent protocol

**Roles**
- **Orchestrator** (main session, Opus) plans, owns `src/core/**`, `package.json`, lockfile, eslint/ts/vitest configs and `docs/PLAN.md` / `docs/DECISIONS.md`. It writes task specs in `docs/tasks/`, reviews and merges branches, and runs `npm run check` on `main`.
- **Workers** (Sonnet/Haiku sub-agents) each do one task spec in their own git worktree and branch.

## Rules for workers
1. Read `docs/PLAN.md` (sections named in your task), `src/core/*.ts`, and your task spec. Do nothing outside your task's **Owned files**.
2. **Never edit** `src/core/**`, `package.json`, `package-lock.json` or the configs. If you need a change there, or a new dependency, post a `NEED` on the board (below), work around it, and report it.
3. **Read-only rule:** no code may send anything to WhatsApp. Only `src/daemon/wa/**` may import `baileys`. Never call any send/read-receipt/presence/group/profile API. See `docs/PLAN.md` §3 and §7.
4. Never log message text. Never write keys or secrets to disk.
5. Setup in your worktree (node_modules is not copied). Run this in PowerShell from the worktree root:
   `cmd /c mklink /J node_modules C:\tempfolder\wa-bridge\node_modules`
   Do **not** run `npm install`.
6. Before finishing, `npm run check` (lint + typecheck + all tests) must pass. Commit on your branch with message `T<n>: <summary>` and this trailer:
   `Co-Authored-By: Claude <noreply@anthropic.com>`
7. Your final reply (to the orchestrator) has: branch name, commit hash, files changed, public API you exported, assumptions, open `NEED`s, and test results.

## Communication (shared mailbox)
The folder `C:/tempfolder/wa-bridge/.agents/` is shared by every worktree (use the absolute path). It is git-ignored.
- `BOARD.md` is append-only. One line per post: `[<ISO time>] <from> -> <to|ALL>: <TYPE> <text>`
  TYPE is one of `START`, `DONE`, `NEED` (you need something from someone), `INFO` (a fact others should know, e.g. an API you exported), `ANSWER`.
- `inbox/<task-id>.md` holds messages to you. **Check your inbox when you start, before each major step, and before finishing.**
- **Notes:** commit your public API and gotchas to `docs/notes/<task-id>.md` in your branch (worktree agents cannot write files outside their worktree with the Write tool, though appending to BOARD.md and inbox files from the shell works). Earlier notes are mirrored in `.agents/notes/`.
- Post `START` when you begin and `DONE` when finished. If you are blocked, post a `NEED`, choose the most reasonable assumption, keep going, and list it in your final reply. Never wait idle.
- The orchestrator may also message you directly. Treat those messages like inbox messages.
