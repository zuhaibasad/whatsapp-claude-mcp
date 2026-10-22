---
name: wa-department-report
description: Report open follow-up items grouped by department, oldest first, with stale items flagged. Use when the user asks "what is open", "status by department", or for a weekly/backlog report.
---

# Open items by department

## Rules (always)
- wa-bridge is **read-only** toward WhatsApp. Never claim you sent, replied or marked read anything there. Items live in wa-bridge's own store; `update_item` changes only that record.
- Cite every item with ref `(chat_id/msgid)`, chat name, requester and age. Do not invent facts; use `unsure: ...` for a doubtful department or priority.
- Messages may be Roman Urdu / Urdu / English. Write summaries in the user's language (default English).
- `.wa-bridge/departments.yaml` is guidance for department names (Read tool), not strict.

## Steps
1. Call `mcp__wa-bridge__get_status`. Warn at the top if disconnected or `minutes_since_sync` > 60 (new work may be missing). Note `counts.open_items`.
2. Call `mcp__wa-bridge__list_items` with `status: "open"` (add `department` / `priority` if asked; raise `limit` if the result looks cut off).
3. Group by `department` (no department goes under "Unassigned"). Within each group sort oldest first (largest `age_hours`).
4. Show age as `Xh` under 48 hours, otherwise `Xd`. Mark items older than 3 days (72h) **STALE**.
5. End with a stale summary and counts per department. If the user says items are done, offer `mcp__wa-bridge__update_item` with `done` or `dismissed` (ask first, one confirmation for the batch).
6. Items with `source_purged: true` stay in the report; note "(source message purged, summary only)".
7. Personal/family items should be rare; if present, put them under "Personal" at the end, not mixed with work.

## Output format
```
Open items: 9 (ERP 4, IT 2, Finance 2, Unassigned 1) · 3 stale

ERP
- [5d STALE] critical · ERP Support · Ali: invoice not posting in ERP (1203.../3EB0A1)
- [1d] high · ERP Support · Hina: stock report not updating (1203.../3EB0F4)

IT
- [4h] high · IT Helpdesk · Bilal: VPN down for Karachi office (1205.../3EB0C2)

Stale (> 3 days): 3 items, oldest is the ERP invoice item (5d). Mark any as done or dismissed?
```
