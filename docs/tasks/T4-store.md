# T4 — SQLite store: schema, FTS5, queries, retention, items

**Model tier:** Sonnet · **Depends on:** nothing (takes an already-open `Db`) · **Owned files:** `src/store/**`, `test/store/**`

Contracts: the `Store` interface and query types in `src/core/contracts.ts`, plus the domain types in `src/core/types.ts`. Schema in PLAN §5. Implement them **exactly**.

## Deliverables
1. `src/store/schema.ts` holds the migration SQL for schema v1 (PLAN §5), stored in `meta.schema_version`. Columns are snake_case. Tables: `accounts, chats, participants, messages, messages_fts, unread_state, items, meta`.
   - `messages` PK is `(chat_id, id)`. Add indexes on `(chat_id, ts)`, `(ts)`, and `(mentions_me, ts)`. **Note the type change:** store `mention_reason TEXT NULL` instead of the `mentions_me INT` in the plan (`MentionReason | null`).
   - FTS5 is an external-content table: `messages_fts(text, content='messages', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2")`. Keep it in sync with AFTER INSERT/UPDATE/DELETE triggers (the standard FTS5 external-content pattern with the `'delete'` command). Messages must therefore have an implicit rowid, so do **not** use WITHOUT ROWID.
   - `items` has UNIQUE `(chat_id, message_id, category)`.
2. `src/store/store.ts`: `export class SqliteStore implements Store`, with `constructor(db: Db)`. Use prepared statements cached on the instance. Use transactions for multi-row writes.
   - `insertMessage`: `INSERT OR IGNORE`. Bump `chats.last_message_at = max(...)` and `accounts.last_message_at`. If the chat row does not exist, create a minimal one: type from JID suffix (`@g.us` → group, else direct), `included=1`. Note that the daemon only inserts messages for included chats.
   - `applyEdit` sets text and `edited=1`. `markDeleted` sets `deleted=1` and **text=NULL**, so deleted text does not linger. The FTS triggers keep the index right.
   - `getNewMessages`: `since:'last_review'` gives, per chat, messages with `ts > coalesce(reviewed_until, 0)`. Only `included=1` chats. Exclude `is_from_me` messages? **No, include them**, because Claude needs to see if I already answered. Order by chat (most recent activity first), then ts asc. Apply the global `limit`, set `truncated`, and return `ChatMessages[]`.
   - `searchMessages`: turn the user query into a safe FTS5 query. Split it into tokens, strip `"`, wrap each in double quotes, and join with spaces (implicit AND). An empty query gives `[]`. Use `snippet(messages_fts, 0, '[', ']', '…', 12)`. Order by bm25 then ts desc. Must never throw on input like `foo" OR (`, `*`, `NEAR`, or Urdu/Arabic script.
   - `getMentions`: `mention_reason IS NOT NULL`, with the same `since` semantics.
   - `listChats`: compute `unreviewed` (not from me, ts > reviewed_until).
   - `setReviewed(undefined, until)` applies to all included chats. Never move `reviewed_until` backwards: store `max(old, until)`. Return the count of rows changed.
   - `purgeOlderThan(cutoff)` deletes from messages (the triggers clean FTS) and returns the count.
   - `saveItems` dedupes on the unique key and returns `{saved, duplicates, ids}` (for duplicates, return the existing id). `listItems` adds `chatName` and `sourcePurged` (= the message row no longer exists), ordered oldest first. `updateItem` sets `updated_at`.
   - `counts()` and `close()`.
   - Row↔type mapping in one place. Booleans are stored as 0/1. `mentions` is stored as a JSON text column.
3. `src/store/index.ts` re-exports `SqliteStore` and the migration helpers.

## Tests (`test/store/`)
Use an **unencrypted in-memory** DB: `new Database(':memory:')` from `better-sqlite3-multiple-ciphers`. Encryption is T2's job. Cover:
migrate is idempotent · insert dedupe · last_message_at bump · edit + delete (FTS no longer finds deleted text) · getNewMessages with last_review per chat, the limit/truncated flag, and excluded chats hidden · setReviewed monotonic · search with tricky input (the list above), Roman Urdu text ("payment kal tak chahiye"), and snippet present · mentions · purge removes FTS rows too · items save/dup/list/update/sourcePurged after purge · counts.

## Acceptance
`npm run check` passes. Write `.agents/notes/T4.md` with the public API and any contract ambiguity you resolved. **Post an `INFO` on the board about the `mention_reason` column** so T5/T6 know.
