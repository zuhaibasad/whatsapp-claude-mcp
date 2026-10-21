# T7 — Daemon runner: ingest, reconnect loop, retention, linking

**Model tier:** Sonnet · **Depends on:** T2 crypto, T3 config, T4 store, T5 helpers, T6 adapter (all merged on main) · **Owned files:** `src/daemon/ingest.ts`, `src/daemon/runner.ts`, `src/daemon/link.ts`, `src/daemon/index.ts`, `test/daemon/ingest.test.ts`, `test/daemon/runner.test.ts`, `test/daemon/link.test.ts`

Read `.agents/notes/T2..T6.md` first. They describe the real APIs. PLAN §1, §3, §5, §8.

## Deliverables
1. `ingest.ts`: `export class Ingestor`, with `constructor(store: Store, getConfig: () => Config, me: () => { id; lid; names } | null, logger)`
   - `onChats(ChatMeta[])` → `store.upsertChat` with `included = isChatIncluded(config, chat)`. Keep an existing name if the new name is null.
   - `onGroups(GroupMeta[])` → upsert chat (type group, name = subject, participantCount) + `replaceParticipants`. Recompute included.
   - `onContacts(...)` → keep an in-memory `Map<jid, name>` for sender names and direct chat names. Update direct chat names when they are null.
   - `onMessages(RawMessage[])`: for each message, ensure the chat row exists (upsert a minimal one with `included` computed). **Skip storing if the chat is not included.** Set `mentionReason = detectMention(msg, me)`. Fill `senderName` from contacts if null. Truncate text to `config.maxTextChars`. Then `store.insertMessage`. Do it in batches inside a transaction if the store exposes one; otherwise loop.
   - `onEdit` → `store.applyEdit`. `onDelete` → `store.markDeleted`.
   - `recomputeIncluded()` re-applies the filter to all chats. Call it at startup and whenever the config file mtime changes (poll every 30 s, which is cheap).
   - Never log text. Counters only (`ingested`, `skipped_excluded`, `duplicates`).
2. `runner.ts`: `export async function runDaemon(opts: { projectRoot: string; deps?: Partial<RunnerDeps> }): Promise<{ stop(): Promise<void> }>`
   - Order: acquireLock → master key from the keychain (missing → throw "run wa-bridge init") → open `store.db` (store key) + migrate → open `auth.db` (auth key) → `useDbAuthState` → **refuse to start if `!hasCreds()`** ("not linked: run wa-bridge link") → createWaClient → wire events to the Ingestor → connect.
   - Connection handling: `open` → `store.upsertAccount({id, lid, pushName, linkStatus:'linked', lastConnectedAt:now})`, `backoff.reset()`. `close` → `setLinkStatus('disconnected')`, then if `shouldReconnect(reason)`: `setTimeout(connect, backoff.next())`; else if `logged_out` → `setLinkStatus('logged_out')`, clear auth, log an error, stop. `restart_required` (normal right after linking) → reconnect immediately once, without backoff. **There must never be more than one connect in flight and never a tight loop.** Unit-test this with fake timers.
   - A `qr` event while running as a daemon (session expired) → set status `logged_out` and stop. The daemon never shows a QR; linking is the CLI's job.
   - Retention: at startup and hourly, `store.purgeOlderThan(now - retentionDays*86400)`. Write `meta.last_purge_at`. `VACUUM` if `meta.last_vacuum_at` is older than 7 days.
   - `meta.last_sync_at` = time of the last event received (throttle writes to once per 10 s).
   - Graceful stop on SIGINT/SIGTERM (and `stop()`): close the client (NOT logout), close the DBs, release the lock.
   - `RunnerDeps` lets tests inject: keyStore, waClientFactory, now/timers, logger. Default deps are the real implementations.
3. `link.ts`: `export async function linkAccount(opts: { projectRoot; onQr(qr: string): Promise<void> | void; timeoutMs?: number = 180000; deps? }): Promise<{ id: string; pushName: string | null }>`
   - Fails if the daemon lock is held by a live process ("stop the daemon first"). Opens the DBs the same way. If already linked (`hasCreds()` and the account is linked), throws `AlreadyLinkedError`.
   - Creates a client and calls `onQr` for every `qr` event (the CLI renders the terminal QR and `qr.png`). On `close` with `restart_required` after scanning → reconnect once (the Baileys pairing flow needs this). On `open` → record the account, close the client, resolve. On timeout or `logged_out` → close, delete `qr.png` if it exists, reject.
   - **Always delete `paths.qrPng` in `finally`.**
4. `index.ts` re-exports.

## Tests
Use the fake WaClient (an EventEmitter implementing `WaClient`), an in-memory store (unencrypted DB), and a fake keystore.
- Ingest: excluded chats are not stored · mention detection applied · text truncated · edit/delete · group participants stored · config change flips inclusion.
- Runner: start → open → status linked · connection_lost → reconnect after backoff (fake timers), and only one in flight · 5 consecutive failures give increasing delays · logged_out → stops, no reconnect, status logged_out · restart_required → immediate single reconnect · purge runs at start · stop() releases the lock and does not call unlink.
- Link: qr → onQr called · restart_required → reconnect → open → resolves · timeout rejects · qr.png deleted in all paths · refuses when a live lock exists.

## Acceptance
`npm run check` passes (including T1's guard). Write `.agents/notes/T7.md`.
