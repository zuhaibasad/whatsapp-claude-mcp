---
name: wa-export
description: Export wa-bridge follow-up items to a CSV or JSON file, and optionally push them to Google Sheets or Notion. Use when the user asks to export, download or share the items list.
---

# Export items

## Rules (always)
- wa-bridge is **read-only** toward WhatsApp. Exporting only writes a file inside the project folder; it never touches WhatsApp.
- State the filter used and the number of rows exported. Do not invent or edit row content. Rows keep their `ref` (cite refs); say `unsure` if anything is unclear.
- Exports contain summaries of the user's chats. Remind the user the file is sensitive and unencrypted, and ask before sending it to any outside service.

## Steps
1. If not stated, ask for the format: `csv` (opens in Excel, Urdu text preserved) or `json`. Default `csv`. Default status filter is `open`.
2. Call `mcp__wa-bridge__whatsapp_items` with `{action: "export", format, status}`. Pass `path` only if the user names one; it must be inside the project folder or the call fails. Do not try to work around that.
3. Report the returned `path` and `count`. If `count` is 0 say so and suggest running `wa-daily-brief` first.
4. If a Google Sheets or Notion connector is available in this session, offer to push the rows. **Ask first**, say what will be sent (row count, columns) and where, and proceed only on a clear yes. If none is available, say so and stop.

## Output format
```
Exported 9 open items to .wa-bridge/exports/items-2026-10-22.csv (CSV, UTF-8).
Note: the file contains summaries of your chats, keep it private.
Push these 9 rows to a Google Sheet? I would send ref, chat, department, priority, summary, requester and age.
```
