# T15 — Chat metadata: contacts & names, LID→phone, activity + unread for every chat, Channels, data-dir migration

**Model tier:** Sonnet · **Owned files:** `src/store/**`, `src/daemon/wa/normalize.ts`, `src/daemon/wa/wa-client.ts`, `src/daemon/ingest.ts`, `src/config/**` (except nothing else), `templates/config.yaml`, `src/host/init.ts`, new `src/host/migrate.ts`, and their tests.

## Problems seen on the user's real data (518 chats)
- 429/430 direct chats and 61/88 groups have **no `last_message_at`**, so the picker can't sort by activity. Excluded chats never get activity, and Baileys chat metadata (`conversationTimestamp`, `unreadCount`) is ignored.
- 224/430 direct chats have **no name**, and 207 have `@lid` ids, so there is no phone number to show or search. Contact names live only in an in-memory map (lost on restart), and LID→PN mapping is unused.
- 3 `@newsletter` chats (WhatsApp Channels) are typed `direct`.
- Claude Desktop (MSIX) redirected the data dir. Windows now uses `%USERPROFILE%\.wa-bridge` (`src/core/paths.ts`, done by the orchestrator), and existing data must be migrated.

Contracts already updated by the orchestrator: `ChatType` now includes `'channel'`; new `Contact` type; `ChatRow` has `phone` and `unreadCount`; `Config.includeChannels` exists. `load.ts` currently hard-codes `includeChannels: false`, and `buildChatRows` sets `phone/unreadCount` to null. **Replace both.**

## Deliverables
1. **Schema v2 migration** (`src/store/schema.ts`, `migrate()` upgrades v1 → v2 in a transaction):
   - `chats.type` CHECK becomes `group|direct|channel`. SQLite needs a table rebuild: create new, copy, drop, rename. Re-create indexes. Retype rows where `id LIKE '%@newsletter'` to `channel`.
   - New `chats` columns `unread_count INT NULL` and `last_activity_at INT NULL`. **Activity is a timestamp only, recorded for every chat including excluded ones (no content).** `last_message_at` stays "last stored message". Backfill `last_activity_at = last_message_at`.
   - New table `contacts(id TEXT PK, phone_jid TEXT, lid TEXT, saved_name TEXT, push_name TEXT, verified_name TEXT, updated_at INT)`, with indexes on `phone_jid` and `lid`.
   - New `Store` methods. Add them to the `Store` interface in `src/core/contracts.ts`; this edit is allowed for these additive methods only.
     - `upsertContact(c: Partial<Contact> & { id: string })`: merges non-null fields. A null never overwrites a value.
     - `getContact(idOrPhoneOrLid)`.
     - `linkLid(lid, phoneJid)` updates both directions.
     - `touchChatActivity(chatId, ts, unreadCount?)`: max() semantics for ts. It creates a minimal chat row if missing, typed by JID suffix. **A new chat created this way gets `included` from the config filter, never blindly 1.** Accept an `included` param from the caller.
   - `listChats` returns `lastActivityAt` and `unreadCount` (extend `Chat` in `types.ts` with optional `lastActivityAt?: number | null; unreadCount?: number | null`; additive change allowed).
2. **WhatsApp adapter** (`wa-client.ts` / `normalize.ts`; read-only guard rules apply):
   - **Chats:** from `chats.upsert`/`chats.update`/`messaging-history.set`, emit `conversationTimestamp` (number or Long; seconds) and `unreadCount` in `ChatMeta`. Extend `ChatMeta` in contracts.ts additively with `lastActivityAt?`, `unreadCount?`.
   - **Newsletters:** emit `@newsletter` chats as `type: 'channel'` (name from the chat/newsletter metadata if present) instead of skipping them. Status and broadcast lists are still skipped. If channel messages arrive through `messages.upsert`, normalize them like DMs (sender = channel). Never call any newsletter write/follow API (the guard denies `newsletter*` names; read fields only).
   - **Contacts:** from `contacts.upsert`/`update` and `messaging-history.set`, map `name` → savedName, `notify` → pushName, `verifiedName`, and `lid`/`phoneNumber`/`jid` fields (check the rc14 Contact type). Emit an extended `contacts` event (extend `WaClientEvents.contacts` payload additively to `Partial<Contact>[]`).
   - **LID mapping:** listen for Baileys' LID-mapping event (rc14: check `lid-mapping.update` or similar in `Types/Events.d.ts`) and the `participantAlt`/`remoteJidAlt` fields on messages. Emit `lid-map` events `{ lid, phoneJid }`. Add `'lid-map'` to `WaClientEvents` additively.
   - **Activity for every message**, including excluded chats: emit a lightweight `activity` event `{ chatId, ts, pushName?, senderId }` for **every** upserted message *before* filtering, so excluded chats get timestamps and push names but no text. Add it to `WaClientEvents` additively.
3. **Ingestor** (`ingest.ts`): persist contacts (`upsertContact`), `linkLid`, `touchChatActivity` (from `activity` and chat meta), and channel chats. Remove the in-memory-only contact map, or make it a cache over the store. Group participants' names feed `upsertContact` too.
4. **Config** (`src/config`):
   - Add `include_channels` (default `false`) to the schema, the template (with a comment) and `load.ts`.
   - `isChatIncluded` handles `channel` via `includeChannels`.
   - `computeRules`/`writeSelection`/`currentSelection` handle three types, with ties going to off for channels.
   - The `chats select` CLI gets a `--set-channels all|none` flag.
5. **`buildChatRows`** (`src/config/selection.ts`):
   - `name` = chat name, else the contact's savedName, else pushName, else verifiedName. Look up the contact by chat id, then via LID→phone.
   - `phone` = `+<digits>` from the chat id when it is a phone JID, else from `contacts.phone_jid` via the LID.
   - `lastMessageAt` = `max(last_activity_at, last_message_at)`. `unreadCount` comes from the chat.
   - **Sort by most recent activity first** (nulls last).
   - Add a pure helper `matchesQuery(row, q)` that also matches phone digits (ignore spaces, `+`, `-` and a leading 0 vs 92). T17 imports the same logic, so export it from `src/config/selection.ts` and keep it DOM-free.
6. **Data-dir migration** (`src/host/migrate.ts`, called first thing in `startHost` and in the CLI `init`/`status` for user mode):
   - If `defaultDataDir()` does not contain `store.db`, and `legacyWindowsDataDir()` does (inside Claude Desktop this resolves to the redirected folder), then **copy** (not move) `store.db`, `auth.db` (+ `-wal`/`-shm` after a checkpoint by opening and closing each DB), the config yamls and `exports/` to the new dir.
   - Then copy the keychain master key from account `keychainAccountId(legacyDir)` to `keychainAccountId(newDir)`, and verify both DBs open with the new key.
   - Write `meta.migrated_from` and leave the old folder in place (log it).
   - Idempotent. Never overwrite an existing new store.
   - Must work while holding the lock in the new dir. The old dir has its own lock file, so ignore it if stale.

## Tests
- v1 → v2 migration on a v1 DB fixture: data kept, newsletters retyped, columns present, idempotent.
- `touchChatActivity` on an excluded chat stores a timestamp but no message.
- Contact merge never nulls existing fields.
- LID link both directions.
- `buildChatRows` naming/phone/sort with a LID chat resolved via mapping.
- Phone digit search (`03001234567`, `+92 300 1234567` and `923001234567` all match). Also run the vectors in `test/fixtures/phone-search-vectors.json` (written by T17) if present.
- Channels filtered by `includeChannels`. Three-type `computeRules` property test.
- Adapter: a fake socket emits `chats.upsert` with conversationTimestamp/unreadCount, a newsletter chat, contacts with name/notify/lid, and a lid-mapping event, and the facade emits the right events. The proxy test still shows no write API accessed.
- Data-dir migration with temp dirs and a fake keychain.

## Acceptance
`npm run check` + `npm run build` pass, including the guard. Notes in `docs/notes/T15.md` (new events, new Store methods, migration behaviour).
