---
name: wa-mentions
description: List WhatsApp messages that mention or reply to the user and draft suggested replies. Use when the user asks "who mentioned me", "what needs my reply" or "draft replies".
---

# WhatsApp mentions and suggested replies

## Rules (always)
- wa-bridge is **read-only**. Never claim you sent or replied on WhatsApp or marked anything read. Every suggested reply is text for the user to copy and send themselves; label it "copy and send yourself".
- Cite each item with its ref `(chat_id/msgid)`, chat name, sender and age. Never invent facts. Say `unsure: ...` when intent is unclear.
- Messages mix Roman Urdu, Urdu script and English. Quote short originals where useful.
- `.wa-bridge/departments.yaml` / `priorities.yaml` are optional guidance (Read tool), not strict rules.

## Steps
1. Call `mcp__wa-bridge__whatsapp_brief` once (with `since` if the user named a period). Warn at the top if `status` says not linked or `minutes_since_sync` > 60. Use `mentions` plus `mentions_me: true` messages in `new_messages`.
2. If a mention is ambiguous (short, refers to earlier context), call `mcp__wa-bridge__whatsapp_read` (`action: "messages"`, `chat`) to read the messages around it. Use `reply_to` to follow threads.
3. For each mention give: who, what they want, ref, reason (`at_mention`, `name`, `reply`), and a suggested reply.
4. Skip mentions that are only thanks; list them in one line at the end. Personal/family chats: draft a reply only if something is clearly asked of the user.
5. Optionally offer `whatsapp_items` (`action: "save"`) for mentions needing follow-up (ask first).

## Suggested reply style
- Match the asker's language mix and tone (Roman Urdu stays Roman Urdu; English stays English). Short and polite.
- Do not promise facts or dates the user has not given. Use placeholders like `<time>` and flag them.

## Output format
```
2 mentions since 09:02

1. [45m] Sales Team · Sara (@mention): "Sir discount approve kar dein, client intezar kar raha hai" (1204.../3EB0B7)
   Wants: approval of the discount on the Acme quote. Urgency: high (client waiting).
   Suggested reply (copy and send yourself):
   "Sara, Acme ka discount dekh kar abhi batata hoon."

2. [3h] ERP Support · Ali (reply to you): asks which invoice number you meant (1203.../3EB0A9)
   Wants: invoice number. unsure: which invoice, check your earlier message.
   Suggested reply (copy and send yourself):
   "Ali, invoice number <number> hai, please check."
```
