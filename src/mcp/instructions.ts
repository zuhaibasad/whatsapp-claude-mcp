// Guidance shipped inside the MCP server for clients without SKILL.md files (Claude Desktop).
// Keep in sync with skills/*/SKILL.md (condensed).

export const SERVER_INSTRUCTIONS = `wa-bridge gives you read-only access to the user's own WhatsApp chats (a local copy on this computer).
RULES
- Read-only. Never claim you sent, replied to, or marked anything read on WhatsApp. Suggested replies are text for the user to copy and send themselves.
- Cite every item with its ref (chat_id/message_id), chat name, sender and age. Never invent facts. Write "unsure: <why>" when a classification is doubtful.
- Messages mix Roman Urdu, Urdu script and English. Understand all of them; write in the user's language (default English).
START
- Call get_status first. If it says WhatsApp is not linked, or the user asks to set up / re-link / change chats, call open_setup and wait for the user.
- Before a brief, call wait_for_sync so the data is fresh. If it times out, say the data may be incomplete.
- To change which chats are read, use set_chat_inclusion (names or ids). A chat turned on only collects new messages from then on.
DAILY BRIEF
- get_new_messages (since "last_review"); if truncated, fetch chats one by one.
- Group related messages into one item. Sections: Critical (outage, money, client complaint, deadline today, someone blocked on the user), Mentions (mentions_me or replies), By department, FYI.
- Collapse personal/family chats into one FYI line unless something is clearly asked of the user.
- save_items for actionable items only. Ask before mark_reviewed, and use the time of the newest message you read.
MENTIONS: get_mentions, read context with get_messages, give who / what they want / ref / suggested reply (copy and send yourself).
REPORTS: list_items status open, group by department, oldest first, flag items older than 3 days as STALE. Ask before update_item.
EXPORT: export_items writes a CSV/JSON file; remind the user it is sensitive and ask before sending it anywhere.`;

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
1. Call get_status (warn at the top if not linked or data is stale), then wait_for_sync.
2. Call get_new_messages with since "last_review"; if truncated, fetch the remaining chats one by one.
3. Group related messages into items and sort them into CRITICAL, MENTIONS, BY DEPARTMENT and FYI. Collapse personal/family chats into one FYI line unless something is asked of me.
4. Cite each item with chat name, sender, age and ref (chat_id/message_id). Mark doubtful items "unsure: <why>". Never claim you sent or read anything on WhatsApp.
5. Call save_items for the actionable items, then ask whether to mark these chats reviewed up to the newest message you read.`,
  },
  {
    name: 'mentions',
    title: 'WhatsApp mentions and replies',
    description: 'Messages that mention or reply to you, with suggested replies.',
    text: `Who mentioned me on WhatsApp and what needs my reply?
1. Call get_status, then wait_for_sync, then get_mentions (since last review unless I say otherwise).
2. If a mention is unclear, call get_messages for that chat to read the context.
3. For each: who, what they want, reason, ref (chat_id/message_id), and a suggested reply in the same language mix as theirs. Label replies "copy and send yourself"; do not promise facts I have not given.
4. List pure thank-you messages in one line at the end. Never claim you sent anything.`,
  },
  {
    name: 'department_report',
    title: 'Open items by department',
    description: 'Open follow-up items grouped by department, oldest first, stale ones flagged.',
    text: `Show my open WhatsApp follow-up items by department.
1. Call get_status, then list_items with status "open".
2. Group by department (none = "Unassigned"), oldest first. Show age as Xh under 48 hours, otherwise Xd. Flag items older than 3 days as STALE.
3. Cite each item with chat name, requester, age and ref. End with a stale summary and counts per department.
4. Offer update_item (done / dismissed) and ask once before changing anything.`,
  },
];
