# T11 — Onboarding chat picker (select groups + DMs at link time, re-runnable)

**Model tier:** Sonnet · **Depends on:** Phase 1 on main · **Owned files:** `src/config/selection.ts`, `test/config/selection.test.ts`, `src/cli/picker/**`, `test/cli/picker.test.ts`, `src/cli/commands/select.ts`, `test/cli/select.test.ts`, edits to `src/daemon/link.ts`, `src/daemon/ingest.ts`, `test/daemon/link.test.ts`, `test/daemon/ingest.test.ts`, `src/cli/commands/link.ts`, `skills/wa-setup/SKILL.md`, and **only the `chats` command registration** in `src/cli/index.ts` (T9 is adding other commands to that file in parallel, so keep your edit small and local).

## Why
The user wants to see every group and DM right after linking and choose which ones wa-bridge reads. They need select all, select none, and per-chat toggles. The choice becomes allowlist/denylist rules in `config.yaml`. **Key constraint:** today, messages from excluded chats are discarded at ingest, so the initial sync for DMs (off by default) is lost before the user can choose. The picker must run during `link`, and excluded-chat messages from the link session must be **held in memory only** (never written to disk) until the user decides.

## Deliverables

### 1. `src/config/selection.ts` (pure + file writer)
- `export interface ChatChoice { id: string; name: string | null; type: ChatType }`
- `computeRules(all: ChatChoice[], selectedIds: Set<string>): { includeGroups: boolean; includeDirectChats: boolean; allowlist: ChatChoice[]; denylist: ChatChoice[] }`
  - Decide each type separately. If selected ≥ half of that type's chats, set the type default to **on**, and every unselected chat of that type goes to the denylist. Otherwise set it to **off**, and every selected chat goes to the allowlist. Ties go to "on" for groups and "off" for DMs.
  - An empty type keeps its current default (take it as a parameter).
  - **Property test:** applying `isChatIncluded` with the resulting config to every chat gives exactly `selectedIds`.
- `writeSelection(paths, rules, opts?: { preserveOtherKeys: true })` updates `config.yaml` with the `yaml` **Document API** (`parseDocument`), so the user's other keys and comments stay intact.
  - Sets `include_groups`, `include_direct_chats`, `allowlist` and `denylist`.
  - Each list entry is the **chat id** with a trailing comment holding the name (e.g. `- "1203...@g.us" # Hisab`). Check what `yaml` 2.x supports for item comments (`commentBefore`/`comment` on scalar nodes) and use it.
  - Existing name-based entries the user typed by hand are replaced only if they refer to a chat in `all` (match by name, case-insensitive). Keep unknown entries.
  - Writes atomically (write a temp file, then rename).
- `currentSelection(cfg: Config, all: ChatChoice[]): Set<string>` returns the chats currently included (to pre-check the picker).

### 2. `src/cli/picker/` — interactive multi-select built on `@inquirer/core` 12 (`createPrompt`, `useState`, `useKeypress`, `usePagination`, `isEnterKey`, …; read its typings)
- Input: `ChatRow[]` (defined in `src/core/contracts.ts`; import it from there in both daemon and CLI). Sort by `lastMessageAt` desc, nulls last.
- The display name is `name`, else the phone number taken from the JID (`92300…@s.whatsapp.net` → `+92300…`), else `(unknown, <id prefix>)`. Truncate by code points (emoji/Urdu safe) to fit `process.stdout.columns`.
- Header line: `Selected: 12/88 groups · 3/432 direct · view: All · filter: "lums"`.
- Each row: `[x] 👥 Hisab                      5 members   2h ago`. Use `👤` for DMs, or `G`/`D` when `NO_COLOR`/ascii mode is set.
- Keys:
  - ↑/↓ move. PgUp/PgDn page. Home/End jump.
  - **Space** toggles the current row.
  - **Typing** filters (case-insensitive substring on the display name and id). Backspace edits the filter. Esc clears the filter, or cancels if the filter is already empty.
  - **Tab** cycles the view: All → Groups → Direct.
  - **Ctrl+A** selects all *visible* rows. **Ctrl+N** deselects all visible rows. **Ctrl+T** inverts the visible rows.
  - **Enter** opens a summary screen ("12 groups, 3 direct chats selected. New groups will be included/excluded by default. New direct chats …"). Then `y` confirms, and `n` or Esc goes back.
  - Footer help line with the keys.
- Returns `Set<string> | null` (null = cancelled). It must work on Windows Terminal, Git Bash (mintty) and PowerShell. Test the Ctrl keys on Windows using the raw `key.name`/`key.ctrl` that `useKeypress` reports. If mintty does not deliver a key, add a fallback (e.g. `F2`/`F3`/`F4`) and list it in the footer.
- If `!process.stdin.isTTY`, the caller does not show the picker. Print a hint to use `wa-bridge chats include/exclude` or edit `config.yaml` instead.

### 3. `src/daemon/ingest.ts` + `src/daemon/link.ts`
- The Ingestor gets an optional `onExcluded?: (msg: RawMessage) => void` hook, called instead of silently dropping a message for an excluded chat. The daemon does not pass it (behaviour unchanged).
- `linkAccount` gets an optional `chooseChats?: (rows: ChatRow[]) => Promise<Set<string> | null>`.
  - While settling, excluded-chat messages go into an in-memory buffer (`Map<chatId, RawMessage[]>`). Cap it at 50,000 messages in total; drop the oldest beyond that and log a warning with counts only.
  - After settle and **after closing the WhatsApp client**, if `chooseChats` is set: build rows from `store.listChats({})` (all chats, including excluded ones), call it, and then:
    - Selection returned: `writeSelection`, reload config, `ingestor.recomputeIncluded()`, then insert buffered messages of now-included chats (with mention detection, via the ingestor). Delete messages already stored for chats that are now excluded (`store` has no per-chat delete; add a small helper in link.ts using the raw store DB handle from `openDaemonDbs`, inside a transaction, since the FTS triggers handle the index).
    - Null returned: keep the defaults and discard the buffer.
  - The buffer is always cleared in `finally`. Return value is unchanged.
  - DBs stay open until the choice is applied. The lock is held the whole time.

### 4. CLI
- `link.ts` command: if stdin is a TTY, pass `chooseChats` = the picker, preceded by the line "Choose which chats wa-bridge may read (you can change this later with `wa-bridge chats select`)". After the choice, print a summary of what was written to `config.yaml`.
- `src/cli/commands/select.ts`:
  - `wa-bridge chats select` opens the picker on the current store chats with the current selection pre-checked. It writes the selection and prints a summary. If the daemon is running, note "the daemon applies this within ~30 s". Warn that turning a chat on only captures **new** messages from now on (history is not re-downloaded).
  - `wa-bridge chats include <name|id>...` and `wa-bridge chats exclude <name|id>...` are non-interactive (for Claude/scripts). Resolve each argument by id, else by exact case-insensitive name, else by unique substring (if ambiguous, list candidates and exit 1). Then compute: current selection ± these → `computeRules` → `writeSelection`. Print the resulting change.
  - Register these as subcommands of the existing `chats` command (the bare `wa-bridge chats` listing must keep working).
- Update `skills/wa-setup/SKILL.md`. The picker appears during `link`, and the user drives it in their own terminal. Claude can use `wa-bridge chats include/exclude` when the user asks in conversation.

## Tests
- `computeRules` property test (random chat sets/selections, 200 iterations, seeded) → `isChatIncluded` reproduces the selection exactly. Plus edge cases: all, none, empty type.
- `writeSelection` keeps other keys and comments, writes id + name comments, is idempotent, and keeps unknown entries.
- Picker via `@inquirer/testing` (`render`): filter, space toggle, Tab views, Ctrl+A/N/T on visible rows only, Enter → summary → y returns the set, Esc returns null.
- Link: excluded-chat messages are not in the DB before the choice. After choosing a DM, its buffered messages are stored. After deselecting a group, its stored messages are deleted. A null choice discards the buffer. The buffer cap works.
- `chats include/exclude` resolution (id, exact name, substring, ambiguous → exit 1).

## Acceptance
`npm run check` + `npm run build` pass. Manually run `node dist/cli/index.js chats select --project <a temp project with a seeded store>` in your terminal if possible, and describe what you saw in your report. Write `docs/notes/T11.md`.
