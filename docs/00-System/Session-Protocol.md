---
type: system
tags: [system, protocol, handoff]
---

# Session protocol (token-lean)

## Start
1. Read the [[HANDOFF]] that the SessionStart hook injected. **Don't** read PLAN, DECISIONS or specs in full; open only the section a task needs.
2. Check `git worktree list` and `git status`, both printed by the hook. Unfinished worker branches are listed in HANDOFF.

## During
- Small changes (under ~50 lines, or merges): do them inline with Edit and terse commands (`| tail`, `grep -E`).
- Delegate only clearly separable work. Use **at most 1–2 workers**, narrow specs in `tasks/`, and Haiku for mechanical work. Ask for **short final reports**.
- Record a decision in [[DECISIONS]] as soon as it's made (2–4 lines).

## End ("handoff" / "wrap up")
1. Write a session log: `02-Sessions/YYYY-MM-DD-<slug>.md`, max ~30 lines: what changed, what's open.
2. **Overwrite** [[HANDOFF]]: current state, in-flight branches, next steps, waiting on the user, gotchas. Keep it under ~80 lines.
3. Link the session log from [[00-Home]].
4. `git add -A && git commit -m "session: YYYY-MM-DD <slug>"`.
