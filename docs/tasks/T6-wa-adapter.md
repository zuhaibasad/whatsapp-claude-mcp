# T6 — WhatsApp adapter (the ONLY Baileys code): encrypted auth state, normalizer, read-only client facade

**Model tier:** Sonnet · **Depends on:** nothing (takes an open `Db`) · **Owned files:** `src/daemon/wa/**`, `test/daemon/wa/**`

Read PLAN §3 (read-only config table), §4 (auth in encrypted DB) and §7 (guard). Contracts: `WaClient`, `WaClientEvents`, `ConnectionState`, `RawMessage`, `ChatMeta`, `GroupMeta` in `src/core/contracts.ts`.
Library: `baileys@7.0.0-rc14` (ESM). Read its `.d.ts` files in `node_modules/baileys/lib/` instead of guessing the API.

## HARD RULES (a guard test, T1, will scan your files)
- Never reference: `sendMessage, relayMessage, sendReceipt(s), readMessages, sendPresenceUpdate, presenceSubscribe, chatModify, star, group*` writes (`groupMetadata` and `groupFetchAllParticipating` reads are OK), `updateProfile*, update*Privacy, updateBlockStatus, removeProfilePicture, addOrEditContact, removeContact, addLabel*, removeLabel*, newsletter*, rejectCall, offerCall, appPatch, resyncAppState, downloadMediaMessage, fetchMessageHistory, requestPlaceholderResend, sendWAMBuffer`.
- `logout` may appear **only inside the method/function named `unlink`** in `wa-client.ts`.
- Never use computed access on the socket (`sock[x]`). Never return or expose the socket object.
- Never log message text or auth keys. Log ids and event types only.

## Deliverables
1. `auth-state.ts`: `useDbAuthState(db: Db): Promise<{ state: AuthenticationState; saveCreds(): Promise<void>; clear(): void; hasCreds(): boolean }>`
   - Table `auth_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)` (create it if missing).
   - Mirror Baileys' `useMultiFileAuthState` semantics (read its source in `node_modules/baileys/lib/Utils/use-multi-file-auth-state.js`). Key = `creds` or `${type}-${id}`. Values are serialized with `JSON.stringify(v, BufferJSON.replacer)` and read with `BufferJSON.reviver`. Handle `app-state-sync-key` with `proto.Message.AppStateSyncKeyData.fromObject`. `null`/`undefined` values delete the row. Run `keys.set` in **one transaction**. New creds come from `initAuthCreds()`.
   - `clear()` deletes all rows (used by unlink).
2. `normalize.ts`: pure functions with no socket access.
   - `normalizeMessage(m: WAMessage, meId: string): RawMessage | null`. Return null for: status broadcasts (`status@broadcast`), protocol messages (`protocolMessage`, except edits/revokes, which are handled by `extractEdit`/`extractDelete`), reactions, `senderKeyDistributionMessage`-only, poll updates, and empty content. Unwrap `ephemeralMessage`, `viewOnceMessage(V2)`, `documentWithCaptionMessage` and `editedMessage`.
   - Text sources: `conversation`, `extendedTextMessage.text`, and captions of image/video/document. `hasMedia`/`mediaType` come from the message kind (image/video/audio/document/sticker/contact/location are "media types"; never download).
   - `contextInfo.mentionedJid` gives `mentions`. `contextInfo.stanzaId` + `participant` give `quotedId`/`quotedSenderId`.
   - `senderId`: groups use `key.participant` (prefer the phone-number JID if `participantAlt`/`participantPn` exists; check the rc14 typings for the field names), direct chats use `key.remoteJid`, and `fromMe` uses `meId`. `ts` comes from `messageTimestamp` (number | Long → number seconds).
   - `extractEdit(m)` → `{chatId, messageId, newText} | null`, and `extractDelete(m)` → `{chatId, messageId} | null` from `protocolMessage` type REVOKE / MESSAGE_EDIT.
3. `wa-client.ts`: `createWaClient(opts: { auth: Awaited<ReturnType<typeof useDbAuthState>>; logger: pino.Logger; browser?: [string, string, string]; socketFactory?: typeof makeWASocket; getMessage?: (key) => Promise<proto.IMessage | undefined> }): WaClient`
   - Socket config, which is **mandatory** and exported as `READ_ONLY_SOCKET_CONFIG` for tests to assert: `markOnlineOnConnect: false`, `syncFullHistory: false`, `fireInitQueries: true`, `emitOwnEvents: false`, `generateHighQualityLinkPreview: false`, `shouldSyncHistoryMessage` = Baileys default (no FULL), `browser` = `Browsers.windows('Desktop')` / `macOS` / `ubuntu` chosen by `process.platform` unless passed in. Set `printQRInTerminal` only if it still exists in rc14 (it is deprecated, so set it false or omit it). `getMessage` returns undefined by default.
   - Fetch the WA version with `fetchLatestBaileysVersion()` **once** at connect (fall back to the default on error).
   - Map Baileys events to facade events: `connection.update` → `connection` (qr / open with `sock.user` id/lid/name / close with a reason mapped from `DisconnectReason`: loggedOut→logged_out, restartRequired→restart_required, connectionReplaced→replaced, badSession→bad_session, forbidden→forbidden, connectionLost/timedOut/connectionClosed→connection_lost, else unknown; `retry` = not logged_out/forbidden/replaced) · `creds.update` → `saveCreds` · `messages.upsert` (types `notify` and `append`) → `messages`, plus `edit`/`delete` via the extractors · `messages.update` with edits → `edit` · `chats.upsert`/`chats.update` → `chats` (name, archived, muted = `muteEndTime > now`) · `groups.upsert`/`groups.update` and `group-participants.update` → re-fetch with `groupMetadata` (read) → `groups` · `contacts.upsert`/`update` → `contacts` · `messaging-history.set` → `chats` + `messages` + `contacts` (whatever the normal initial sync gives).
   - After `open`, call `groupFetchAllParticipating()` **once** per connection and emit `groups`. That is the read WhatsApp Web itself does.
   - `connect()` creates the socket and resolves when the socket is created (not when it is open). `close()` calls `sock.end(undefined)` and does **not** log out. `unlink()` → `await sock.logout()` then `auth.clear()`.
   - The facade is a small typed EventEmitter. The `sock` variable stays private inside the closure.
4. `index.ts` re-exports `createWaClient`, `useDbAuthState`, `READ_ONLY_SOCKET_CONFIG` and the normalizer.

## Tests (`test/daemon/wa/`, mocking the library)
- `socketFactory` is a fake that returns `{ ev: EventEmitter-like with on/off/emit, user, end, logout, groupFetchAllParticipating, groupMetadata }` **and** a Proxy that records any other property access. Assert that the config passed has `markOnlineOnConnect:false` and `syncFullHistory:false`. Drive connect → qr → open → messages.upsert → edit → revoke → chats/groups → close, and assert that **no** send-type method was ever accessed on the socket (check the Proxy access log against the denylist names).
- Normalizer: text, extended text with mention + quote, an image with caption, ephemeral-wrapped, view-once, a status broadcast → null, a reaction → null, a revoke → extractDelete, an edit → extractEdit, a group participant vs direct, and a Long timestamp.
- auth-state round-trip in an in-memory DB: creds survive reopen, keys set/get/delete, app-state-sync-key revival, transaction.

## Acceptance
`npm run check` passes. Write `.agents/notes/T6.md` with the exact facade API, which events fire when, and any Baileys rc14 quirks you found (field names for LID/PN alt). T7 (daemon runner) depends on it.
