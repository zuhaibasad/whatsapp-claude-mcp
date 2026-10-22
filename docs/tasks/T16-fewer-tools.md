# T16 — Fewer, smarter MCP tools (fewer permission prompts, fewer tokens) + picker-first chat changes

**Model tier:** Sonnet · **Owned files:** `src/mcp/**`, `test/mcp/**`, `skills/**`, `scripts/smoke-mcpb.mjs`, `packaging/mcpb/manifest.json`, `src/host/server.ts` + `src/host/core.ts` + `src/host/client.ts` (only the `openSetup(screen)` change) and their tests.

## Why
User feedback from the first real Desktop install:
- Claude Desktop asks "Allow?" the first time **each** tool is used. About 15 model-visible tools means about 15 confusing prompts. An extension cannot grant itself permission, so the only lever we have is fewer tools.
- A brief makes 4–6 tool calls, and every call re-sends the whole conversation, which costs tokens.
- "Add a new chat" should open the chat picker on its own.

## New model-visible tool set (exactly 7; keep the old handlers internally)
| Tool | Replaces | Notes |
|---|---|---|
| `whatsapp_status {wait_for_sync_seconds?: 0–120 = 0}` | get_status, wait_for_sync | Optionally waits for `live` first. |
| `whatsapp_brief {since?: "last_review"\|ISO\|"7d" = "last_review", limit?: = 300, wait_for_sync_seconds?: = 45}` | get_new_messages + get_mentions + get_status + list_items(open) | **One call for a brief.** Waits for sync, then returns `{ status: {…compact}, new_messages: {chats:[…], truncated}, mentions: […], open_items_count }`. Same message shape/limits/80k budget as today. Mentions are deduped against new_messages: include only refs not already present, else the ref list only. |
| `whatsapp_read {action: "chats"\|"messages"\|"search"\|"chat_info", chat?, query?, since?, until?, limit?, filter?}` | list_chats, get_messages, search_messages, get_chat_info | Validate the required args per action with clear errors. |
| `whatsapp_items {action: "save"\|"list"\|"update"\|"export", items?, id?, status?, department?, priority?, format?, path?}` | save_items, list_items, update_item, export_items | |
| `whatsapp_mark_reviewed {chats?, until}` | mark_reviewed | |
| `whatsapp_setup {screen?: "auto"\|"chats" = "auto"}` (MCP App tool, `ui://wa-bridge/setup.html`) | open_setup | `screen:"chats"` opens straight to the picker when linked. |
| `whatsapp_choose_chats {include?: string[], exclude?: string[]}` | set_chat_inclusion | **Description:** "Only when the user names specific chats to add or remove. If the user wants to add or remove chats without naming them, or to browse, call `whatsapp_setup` with `screen: \"chats\"` instead." |

- **Descriptions** must be short, plain and decisive (≤ 2 sentences + arg docs). Claude must reach for `whatsapp_brief` for any "brief / summary / what's new / what needs my attention" request, and for `whatsapp_setup {screen:"chats"}` for "add/remove/change chats" without names. Annotations: `readOnlyHint: true` on status/brief/read. Items, mark_reviewed and choose_chats change only wa-bridge's own records, so state that in the description.
- App-only `setup_*` tools stay as they are (hidden; the panel uses them).
- **Initial screen to the UI.** `whatsapp_setup` returns `structuredContent: { initialScreen: "chats" | "auto" }`. T17 reads it in `ontoolresult`. Browser fallback: `openSetup(screen)` → the host appends `&screen=chats` to the one-time URL it opens itself. Update `HostOps.openSetup(screen?: 'auto'|'chats')` and the `/api/open-setup` body `{screen}` in `src/host/{core,server,client}.ts`.
- **Server `instructions`** (≤ 20 lines): use `whatsapp_brief` for briefs (one call); use the picker for chat changes; read-only rules; cite refs; say when unsure. Also tell Claude: if the user is bothered by permission prompts, explain **Settings → Extensions → WhatsApp Bridge → set the tools to "Always allow"** (we cannot change this ourselves).
- **Prompts** (`daily_brief`, `mentions`, `department_report`) use the new tool names.
- **Skills** (`skills/*/SKILL.md`): rewrite for the new tool names, keeping them short. `wa-daily-brief` = `whatsapp_brief` → classify → `whatsapp_items save` → ask → `whatsapp_mark_reviewed`.
- `packaging/mcpb/manifest.json` tools list is updated to the 7 tools. Bump version to `0.2.0` in manifest and package.json.
- Smoke script is updated to the new names.

## Token budget check
Add a test that serialises `tools/list` for a client **without** UI support and asserts the total description + schema JSON is **< 6,000 characters**. Print the number in the notes.

## Tests
- Exactly 7 model-visible tools (plus the setup_* tools only with UI support).
- `whatsapp_brief` waits for sync (fake host), returns the combined shape, and dedupes mentions.
- `whatsapp_read`/`whatsapp_items` route per action and reject bad args.
- `whatsapp_setup` returns `initialScreen`. The browser fallback passes the screen and returns no URL.
- The nonce/QR leak tests still pass.
- Prompts use the new names.

## Acceptance
`npm run check`, `npm run build`, `npm run build:mcpb` and `npm run smoke:mcpb` pass. Notes in `docs/notes/T16.md`, including the before/after tool-definition size.
