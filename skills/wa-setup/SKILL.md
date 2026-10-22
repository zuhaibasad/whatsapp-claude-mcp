---
name: wa-setup
description: Guided first-time install of chatai: Node check, init, linking WhatsApp by QR, starting the daemon, configuring chats and departments, and scheduling the daily brief. Use when the user wants to set up, install or re-link chatai, or tools report "not initialised".
---

# chatai setup

## Rules (always)
- chatai is **read-only**. It receives messages as a linked device; it never sends, replies, marks read or changes groups. Never claim otherwise.
- **Never set `CHATAI_ACCEPT_RISK`, never use `--accept`, never type "I accept" for the user.** The user must read the warning and type `I accept` themselves in their own terminal. If a command would prompt for it, tell the user to run it themselves.
- Never print or ask for keys, QR contents or message text. Do not edit files outside the project folder.
- Be honest: WhatsApp's terms do not allow unofficial clients, so the account could in theory be restricted. This is why the user accepts it personally.
- Say when something is uncertain (`unsure: ...`); cite refs when later showing messages.

## Steps (confirm each before moving on)
1. **Node.** Run `node --version`. Need >= 22.12. If lower, ask the user to upgrade and stop.
2. **Init.** Ask the user to run `npx chatai init` in the project folder in their own terminal; it shows a risk warning and needs `I accept` typed by them. Afterwards summarise the warning in 3 lines (unofficial client, read-only, local encrypted store) and confirm `.chatai/` exists.
3. **Link.** Ask the user to run `chatai link` and scan the QR shown in the terminal (or `.chatai/qr.png`) via WhatsApp > Linked devices > Link a device. Wait for confirmation.
4. **Daemon.** Run, or ask the user to run, `chatai daemon start --detach`. When `chatai daemon install` is available (Phase 3), offer it so collection survives reboots.
5. **Verify.** Run `chatai status` and call `mcp__chatai__whatsapp_status`. Expect `link_status: linked` and `daemon_running: true`. Otherwise read `warnings`, check `.chatai/daemon.log` (never paste message text) and explain the next step.
6. **Chats.** Run `chatai chats --all`, then help edit `.chatai/config.yaml`: `my_names` (names and nicknames, for mention detection), `allowlist` / `denylist` (denylist wins), `include_groups`, `include_direct_chats` (off by default), `retention_days`, `timezone`. Suggest denying personal/family groups the user does not want read. Edits apply within about a minute; excluded chats are not stored at all.
7. **Per-chat notes, disconnecting, health.** `departments.yaml` also takes a `chats:` list (`chat`, `department`, `note`) for per-chat guidance. To disconnect/unlink WhatsApp, call `whatsapp_setup` with `screen: "disconnect"`; the user confirms in the panel (you cannot do it yourself). If something seems broken, call `whatsapp_status` with `diagnose: true` and explain the failed checks and their fixes.
8. **Departments.** Help edit `.chatai/departments.yaml` (name, keywords, examples; Roman Urdu examples are fine) and `priorities.yaml`.
9. **Try it.** Run the `wa-daily-brief` skill once and review the result with the user.
10. **Schedule.** Offer a scheduled task (for example 09:00 and 17:00 on weekdays) running `wa-daily-brief`, using Claude's own scheduling. Ask before creating it.

## Output format
One numbered step at a time:
```
Step 2/9: Init. Please run this in your terminal and type "I accept" yourself when asked:
  npx chatai init
Tell me when it's done.
```
