# T17 — Picker & setup UX fixes (Channels tab, recency, unread, phone search, open-to-picker, permissions tip)

**Model tier:** Sonnet · **Owned files:** `ui/**`, `test/ui/**`, `scripts/build-ui.mjs`.

User feedback from the first real Desktop install:
- The "All" tab showed only groups and was not ordered by latest activity.
- Direct chats showed "Unknown", and searching recent numbers found nothing.
- Channels appeared under Direct.
- "Add a chat" should land directly in the picker.
- Permission prompts confused the user.

The data fixes are in T15 (rows will carry `name`, `phone`, `lastMessageAt` = latest activity for every chat, `unreadCount`, and `type: 'channel'`). The tool changes are in T16 (`whatsapp_setup` returns `structuredContent.initialScreen`). Code against `ChatRow` in `src/core/contracts.ts` (already updated). **Do not import from `src/config/`**, because it pulls in Node-only modules that cannot go in the browser bundle. Implement the search rule in `ui/logic.ts`: match name and phone digits, ignoring spaces, `+` and `-`, and treat a leading `0` like `92`. T15 implements the same rule server-side (`matchesQuery`). Add a shared test-vector file `test/fixtures/phone-search-vectors.json` (you own it) that both test suites can use.

## Changes
1. **Tabs:** All · Groups · Direct · **Channels**, each with a count. Channels are excluded by default, so the header line also mentions channels when there are any.
2. **Ordering:** a small sort toggle, **Recent** (default: `lastMessageAt` desc, nulls last) / **Unread first** (`unreadCount` desc, then recent). The "All" tab must interleave groups and direct chats by recency.
3. **Rows:**
   - The name falls back to the formatted phone (`+92 300 1234567`), then to "Unknown contact".
   - Show the phone under the name for direct chats when a name exists.
   - An **unread badge** (a small pill with the count) when `unreadCount > 0`.
   - The relative time uses `lastMessageAt`.
   - Channel rows use the 📢 icon.
4. **Search:** matches name *and* phone digits (see above). Placeholder: "Search name or number".
5. **Open straight to the picker:**
   - MCP App host: read `structuredContent.initialScreen` from the first `ontoolresult`. When it is `"chats"` and the state is `done`/`choose_chats`, go straight to the picker.
   - Browser host: read `?screen=chats` from the URL.
   - After Save from this entry point, show the short summary plus "Done — you can close this panel".
6. **"Make it smooth" step** after the first successful Save during onboarding (not on later visits), with a "Skip" link. Title: "One last thing: stop the permission pop-ups". Text: "Claude asks before using each WhatsApp tool for the first time. To stop that: open **Settings → Extensions → WhatsApp Bridge** and set the tools to **Always allow**. wa-bridge can only read; it never sends anything." Add a "Got it" button. Plain language, no jargon. It is shown only in the MCP App host (Desktop); in the browser host, show a Claude Code variant instead: "When Claude asks to use a wa-bridge tool, choose *Yes, and don't ask again*".
7. **Mock data** (`ui/dev-mock.ts`): add channels, LID-style direct chats with only a phone, unread counts and interleaved recency. Check every screen in headless Edge (as T13 did) and describe the screenshots in your notes.

## Tests (pure logic)
- Tab counts with channels.
- Recent vs unread-first sort, with All interleaved.
- Name/phone fallback formatting.
- Phone digit search variants.
- initialScreen routing (auto/chats × state).
- The permissions step shows only once, after onboarding.

## Acceptance
`npm run check` + `npm run build` pass. The bundle stays < 600 KB. Notes in `docs/notes/T17.md`.
