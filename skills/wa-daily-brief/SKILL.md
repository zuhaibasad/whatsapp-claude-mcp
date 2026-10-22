---
name: wa-daily-brief
description: Produce the user's briefing of new WhatsApp group messages since their last review, sorted into Critical, Mentions, By department and FYI. Use when the user asks for a daily/morning/evening brief, "what did I miss", or "catch me up on WhatsApp".
---

# WhatsApp daily brief

## Rules (always)
- wa-bridge is **read-only**. Never say you sent, replied to or marked anything as read on WhatsApp. Suggested replies are text for the user to copy.
- Cite every item as `(chat_id/msgid)` plus chat name, sender and age. Never invent facts that are not in the messages.
- If a classification is uncertain, write `unsure: <why>` rather than guessing.
- Messages mix Roman Urdu, Urdu script and English. Understand all of them. Quote short originals where useful. Write the brief in the user's language (default English).
- `.wa-bridge/departments.yaml` and `.wa-bridge/priorities.yaml` are guidance, not strict rules. Read them with the Read tool (if missing, use common sense).

## Steps
1. Call `mcp__wa-bridge__whatsapp_brief` once (it waits for sync and returns `status`, `new_messages`, `mentions`, `open_items_count`). If `status.link_status` is not `linked` or `status.minutes_since_sync` > 60, put a warning line at the very top. If unlinked, call `whatsapp_setup`.
   If `new_messages.truncated` is true, read the busiest chats with `whatsapp_read` (`action: "messages"`, `chat`, `since`) and tell the user if anything is still cut off.
2. Mentions are already in the result (`mentions`, plus `mentions_me: true` messages in `new_messages`). Do not call another tool for them.
3. Read the two YAML files above.
4. Classify each conversation (group related messages into one item; do not list every message):
   - **Critical**: outage, money/payment problem, client complaint, deadline today, security incident, or a person clearly blocked on the user.
   - **Mentions**: `mentions_me: true`, or replies to the user (see `mentions`).
   - **By department**: other actionable items, grouped by department from `departments.yaml` (ERP, IT, Finance, ...). Use "Other" if none fits.
   - **FYI**: updates, thanks, announcements, no action needed.
5. **Personal / family / social groups**: the user's data includes them. Do not list them item by item. Collapse into one FYI line, e.g. "3 family/social chats active (about 40 messages), nothing addressed to you." Only surface personal content as an action item if it clearly asks the user for something (a direct question, a request, a deadline for them). When in doubt, FYI with `unsure`.
6. Call `mcp__wa-bridge__whatsapp_items` with `action: "save"` for actionable items only (Critical, Mentions needing action, department items): `items: [{ref, category, department, priority, summary, requester}]`. Use the ref of the message that best represents the item. It de-duplicates. Do not save FYI items.
7. Write the brief, then ask: "Mark these chats as reviewed up to <time>?" Only on a clear yes call `mcp__wa-bridge__whatsapp_mark_reviewed` with `until` = the timestamp of the newest message you actually read (this moves wa-bridge's own bookmark, not anything in WhatsApp).

## Output format
```
Brief: 14 new messages in 5 chats since 09:02 (2 critical, 1 mention)

CRITICAL
- [2h] ERP Support · Ali: invoice not posting in ERP, needed today (1203.../3EB0A1)  [Finance/ERP, critical]

MENTIONS
- [45m] Sales Team · Sara: asks you to approve discount for Acme quote (1204.../3EB0B7)

BY DEPARTMENT
IT
- [5h] IT Helpdesk · Bilal: VPN down for Karachi office (1205.../3EB0C2) [unsure: may be fixed, later msg says "chal gaya?"]

FYI
- Ops: shipment tracking update shared (1206.../3EB0D9)
- 3 family/social chats active, nothing addressed to you.

Mark these chats as reviewed up to 14:31?
```

## Mixed-language example
Message from Ali in "ERP Support": "Sir invoice ERP mein post nahi ho raha, aaj tak chahiye".
Meaning: the invoice will not post in the ERP and is needed by end of today.
Classify: department **Finance/ERP** (invoice + ERP), priority **critical** (deadline today, blocked process). If it were only "invoice kab tak post hoga?" with no deadline, use **high** and add `unsure: no deadline stated`. If it is unclear whether Ali is asking the user or the group, say so.
