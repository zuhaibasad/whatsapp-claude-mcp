# T10 — Claude skills (5 × SKILL.md)

**Model tier:** Sonnet · **Depends on:** T9 tool names (PLAN §6) · **Owned files:** `skills/**`

Each skill is `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`: one or two sentences saying *when* to use it) and a concise body. Tools are referred to by their MCP names (`mcp__wa-bridge__get_new_messages` etc.; the server name is `wa-bridge`).

Shared rules for every skill (put them in each body, short):
- wa-bridge is **read-only**. Never claim you sent, replied to, or marked anything as read on WhatsApp. Suggested replies are text for the user to copy.
- Messages mix languages (Roman Urdu, Urdu script, English). Understand them; quote short originals where useful; write the brief in the user's language (default English).
- Say when a classification is uncertain ("unsure: …"). Never invent facts not in the messages.
- Cite every item with its ref (`chat/msgid`), chat name, sender and age.
- First call `get_status`. If the bridge is disconnected or stale (>60 min), say so at the top.
- Read `departments.yaml` / `priorities.yaml` guidance via the files in `.wa-bridge/` (Read tool) as guidance, not strict rules.

Skills:
1. `wa-daily-brief`: status → `get_new_messages(since:"last_review")` (page with chats if truncated) → classify into **Critical / Mentions / By department / FYI** → `save_items` for actionable ones → brief: a short header with counts, then sections with bullets `[age] Chat · Sender: what they need (ref)` → ask "Mark these chats as reviewed up to <time>?" → only on yes call `mark_reviewed`.
2. `wa-mentions`: `get_mentions` → for each: who, what, ref, plus a **suggested reply** in the same language mix as the asker (marked "copy and send yourself").
3. `wa-department-report`: `list_items(status:"open")` grouped by department, oldest first, with age, plus a line on stale items (> 3 days).
4. `wa-export`: `export_items(format)` → report the path. If a Google Sheets / Notion connector is available, offer to push the rows there (ask first).
5. `wa-setup`: guided install. Check Node ≥ 22.12 → `npx wa-bridge init` (the user must type `I accept` themselves in their terminal; Claude must **not** set `WA_BRIDGE_ACCEPT_RISK`) → show the warning summary → `wa-bridge link` (tell the user to scan the QR shown in the terminal or `.wa-bridge/qr.png`) → `wa-bridge daemon install` (Phase 3) or `daemon start --detach` → help edit `config.yaml` (my_names, allow/deny), `departments.yaml` → run `wa-daily-brief` once → offer to create a scheduled task (e.g. 09:00 and 17:00) with Claude's own scheduling.

Also add `skills/README.md` explaining how the skills are installed (copied to `.claude/skills/`).
