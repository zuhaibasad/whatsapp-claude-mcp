# T5 — Daemon pure helpers: backoff, mention detection, lock file

**Model tier:** Haiku · **Depends on:** nothing · **Owned files:** `src/daemon/backoff.ts`, `src/daemon/mentions.ts`, `src/daemon/lock.ts`, `test/daemon/backoff.test.ts`, `test/daemon/mentions.test.ts`, `test/daemon/lock.test.ts`

Do **not** touch `src/daemon/wa/**` (that is T6). Types come from `src/core/types.ts` and `src/core/contracts.ts`.

## Deliverables
1. `backoff.ts`: `export class Backoff`
   - `constructor(opts = { baseMs: 5000, factor: 2, maxMs: 600000, jitter: 0.2, random: Math.random })`
   - `next(): number` returns the delay. The first call returns about `baseMs`, then it doubles up to `maxMs`. Jitter is ±20% of the delay, and the result is clamped to ≥ baseMs·0.8.
   - `reset()` (call on a successful `open`) and `attempts` (getter).
   - `export function shouldReconnect(reason: ConnectionState & {state:'close'}): boolean` returns false for `logged_out`, `forbidden`, `replaced` and `bad_session`. Otherwise it returns `reason.retry`.
2. `mentions.ts`: `export function detectMention(msg: RawMessage, me: { id: string; lid: string | null; names: string[] }): MentionReason | null`
   - Returns null if `msg.isFromMe`.
   - `'at_mention'` if `msg.mentions` contains `me.id` or `me.lid`. Compare **normalized** JIDs: strip the device suffix (`92300…:12@s.whatsapp.net` → `92300…@s.whatsapp.net`) and lowercase.
   - Else `'reply'` if `msg.quotedSenderId` normalizes to me.
   - Else `'name'` if the text contains any of `me.names` as a **whole word**, case-insensitive and Unicode-aware. Use `\p{L}\p{N}` boundaries with the `u` flag, not `\b`, because names may be followed by Urdu suffixes or punctuation like "Zuhaib," / "@Zuhaib" / "zuhaib bhai". Ignore names shorter than 2 chars. Escape regex specials.
   - Export `normalizeJid(jid: string): string`.
3. `lock.ts`: single-instance PID lock.
   - `acquireLock(file: string): { release(): void }` writes `{pid, startedAt}` JSON using an exclusive create (`fs.openSync(file, 'wx')`). If the file exists, read the pid and check whether it is alive (`process.kill(pid, 0)`, where an ESRCH error means dead). A stale lock is removed and acquired again. A live one throws `DaemonAlreadyRunningError` with the pid.
   - `readLock(file): { pid: number; startedAt: number; alive: boolean } | null` (used by `status`).
   - `release()` deletes the file only if it still contains our pid.

## Tests
Backoff sequence with `random` stubbed to 0.5 (no jitter): 5s, 10s, 20s … capped at 600s. Reset works. Jitter stays in bounds. shouldReconnect table.
Mentions: @mention by id, by lid, with a device suffix · reply · name at start/end/with punctuation/inside another word (must **not** match "Zuhaibx") · mixed text "Zuhaib bhai ye check karo" · isFromMe gives null · empty names.
Lock: acquire/release · a second acquire throws · a stale pid (use a pid like 999999) gets taken over · readLock alive flag.

## Acceptance
`npm run check` passes. Write `.agents/notes/T5.md`.
