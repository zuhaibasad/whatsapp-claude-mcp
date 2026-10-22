// Guidance shipped inside the MCP server for clients without SKILL.md files (Claude Desktop).
// Keep in sync with skills/*/SKILL.md (condensed).

export const SERVER_INSTRUCTIONS = `wa-bridge gives you read-only access to the user's own WhatsApp chats (a local copy on this computer).
- Read-only. Never claim you sent, replied to, or marked anything read on WhatsApp. Suggested replies are text for the user to copy and send themselves.
- Cite every item with its ref (chat_id/message_id), chat name, sender and age. Never invent facts. Write "unsure: <why>" when doubtful. Messages mix Roman Urdu, Urdu and English; answer in the user's language.
- Brief / summary / what's new / what needs attention: call whatsapp_brief ONCE (it waits for sync and includes status, new messages, mentions and the open-item count). Do not call other tools first.
- Brief format: Critical (outage, money, client complaint, deadline today, someone blocked on the user), Mentions, By department, FYI. Collapse personal/family chats into one FYI line. If truncated, read the busiest chats with whatsapp_read instead of marking everything reviewed.
- Then whatsapp_items save for actionable items only, and ask before whatsapp_mark_reviewed (use the time of the newest message you read).
- Not linked, set up, re-link, or add/remove/browse chats without naming them: call whatsapp_setup (screen "chats" for the picker) and wait for the user. Only when the user names specific chats, use whatsapp_choose_chats. Newly added chats collect new messages only.
- Context, search or chat details: whatsapp_read. Open items and reports: whatsapp_items list (oldest first, STALE after 3 days; ask before update). Export files are sensitive: ask before sending them anywhere.
- Disconnect/unlink WhatsApp: call whatsapp_setup with screen "disconnect"; the user confirms in the panel (you cannot do it yourself). If something seems broken, call whatsapp_status with diagnose true.
- Per-chat guidance: when the user says what a chat is for ("the ERP group is for supplier invoices"), add it under chats: in departments.yaml (chat, department, note); results then carry chat_note per chat.
- If the user is bothered by permission prompts, tell them: Settings, Extensions, WhatsApp Bridge, set the tools to "Always allow". You cannot change this yourself.`;

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  text: string;
}

export const PROMPTS: PromptDef[] = [
  {
    name: 'daily_brief',
    title: 'WhatsApp daily brief',
    description: 'Brief of new WhatsApp messages since your last review.',
    text: `Give me my WhatsApp brief.
1. Call whatsapp_brief once (warn at the top if status says not linked or data is stale).
2. Group related messages into items and sort them into CRITICAL, MENTIONS, BY DEPARTMENT and FYI. Collapse personal/family chats into one FYI line unless something is asked of me. If truncated, read the busiest chats with whatsapp_read.
3. Cite each item with chat name, sender, age and ref (chat_id/message_id). Mark doubtful items "unsure: <why>". Never claim you sent or read anything on WhatsApp.
4. Call whatsapp_items with action "save" for the actionable items, then ask whether to call whatsapp_mark_reviewed up to the newest message you read.`,
  },
  {
    name: 'mentions',
    title: 'WhatsApp mentions and replies',
    description: 'Messages that mention or reply to you, with suggested replies.',
    text: `Who mentioned me on WhatsApp and what needs my reply?
1. Call whatsapp_brief once and use its mentions (plus mentions_me messages in new_messages).
2. If a mention is unclear, call whatsapp_read with action "messages" for that chat to read the context.
3. For each: who, what they want, reason, ref (chat_id/message_id), and a suggested reply in the same language mix as theirs. Label replies "copy and send yourself"; do not promise facts I have not given.
4. List pure thank-you messages in one line at the end. Never claim you sent anything.`,
  },
  {
    name: 'department_report',
    title: 'Open items by department',
    description: 'Open follow-up items grouped by department, oldest first, stale ones flagged.',
    text: `Show my open WhatsApp follow-up items by department.
1. Call whatsapp_items with action "list" and status "open".
2. Group by department (none = "Unassigned"), oldest first. Show age as Xh under 48 hours, otherwise Xd. Flag items older than 3 days as STALE.
3. Cite each item with chat name, requester, age and ref. End with a stale summary and counts per department.
4. Offer whatsapp_items action "update" (done / dismissed) and ask once before changing anything.`,
  },
];
