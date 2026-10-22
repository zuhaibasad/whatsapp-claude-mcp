# ChatAI for WhatsApp (repo: wa-bridge): operating notes for Claude

A read-only WhatsApp bridge for Claude Desktop (`.mcpb`) and Claude Code. TypeScript/Node, Windows first. **`docs/` is the Obsidian vault and the shared memory between sessions.**

## Every session
- The SessionStart hook prints `docs/00-System/HANDOFF.md`, the worktrees and git status. Start from that.
- Follow `docs/00-System/Session-Protocol.md`. On "handoff" or "wrap up": write a session log, overwrite HANDOFF, commit.

## Token economy (the user's account usage burns fast)
- Don't read `docs/PLAN.md`, `DECISIONS.md` or task specs in full. Grep or open only the needed section.
- Do small fixes and merges inline. Use at most 1–2 worker agents, Haiku for mechanical work, narrow specs, short reports.
- Keep command output short: `| tail -5`, `grep -E "Tests |✖|error TS"`.

## Hard rules
- **Read-only WhatsApp:** never send, react, mark read or show presence. `test/guard/` fails the build on any write-API name; `logout` is allowed only in `unlink` in `src/daemon/wa/wa-client.ts`.
- Never log message text, QR strings, tokens or nonces. Data stays local, encrypted, with the key in the OS keychain.
- Before committing: `npm run check`. Before handing a build to the user: `npm run build:mcpb && npm run smoke:mcpb`.
- Windows shells eat backslashes. Use Edit/Write or `path.join` for Windows paths and regexes.
