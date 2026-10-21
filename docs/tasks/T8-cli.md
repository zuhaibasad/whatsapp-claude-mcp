# T8 — CLI (Phase 1 commands)

**Model tier:** Sonnet · **Depends on:** T2–T7 merged · **Owned files:** `src/cli/**`, `test/cli/**`

Read `.agents/notes/T2..T7.md`. PLAN §4, §7, §8. Brief §7 (commands). Library: `commander` 15, `qrcode` (`toString(qr, {type:'terminal', small:true})` and `toFile(path, qr)`).

## Commands (Phase 1)
Global option `--project <dir>` (default cwd) → `resolvePaths`. `--json` on read commands prints machine JSON; the default is a compact human table. Exit codes: 0 ok, 1 error, 2 not initialised/linked.

- `wa-bridge init`
  1. Print the **warning** (constant `RISK_WARNING` in `src/cli/warning.ts`): unofficial linked-device use is against WhatsApp's ToS and can get the number restricted or banned · other chat members did not consent to their messages being stored or read by an AI · message text is sent to Anthropic when Claude reads it through the tools · read-only: wa-bridge never sends, never marks as read, never shows you online · data stays in `.wa-bridge/`, encrypted, key in the OS keychain.
  2. Require typing exactly `I accept` (from `ACCEPT_PHRASE`). Anything else aborts with exit 1. `--accept` flag for non-interactive use, **only if** env `WA_BRIDGE_ACCEPT_RISK=I accept` is also set (so an agent cannot silently bypass it).
  3. Create `.wa-bridge/`, the master key (if missing; never overwrite), empty encrypted `store.db` (migrate) and `auth.db`, and default config files (`writeDefaultConfigs`). Store `meta.risk_accepted_at`.
  4. Ensure `.wa-bridge/` is in `<project>/.gitignore` (create or append; idempotent).
  5. Print next steps.
- `wa-bridge link`: requires init. Calls `linkAccount` with `onQr` → print the terminal QR + write `qrPng`, and print "WhatsApp → Settings → Linked devices → Link a device. Scan within ~60s. qr.png is deleted after linking." On success, print the linked number and "start the daemon: wa-bridge daemon start".
- `wa-bridge daemon start`: Phase 1 runs **in the foreground** (`runDaemon`, logs to `logFile` + a short console line). `--detach` spawns a detached child (`process.execPath` + this script + `daemon start`, `stdio: 'ignore'`, `windowsHide: true`, `detached: true`, `unref()`) and prints its pid. `daemon stop` reads the lock and sends SIGTERM to the pid (on Windows `process.kill(pid)` works). `install`/`uninstall` print "Phase 3".
- `wa-bridge status` prints initialised?, link status, account, daemon running (lock alive) + pid, last connected, last sync (minutes ago), counts, retention days, and warnings (daemon not running; no sync > 60 min; logged out → relink). Works without the keychain for the "not initialised" case.
- `wa-bridge chats [--all|--direct|--groups] [--active-since 7d]` lists chats with unreviewed counts and included flag.
- `wa-bridge new [--since <iso|duration>|last_review] [--limit 200]` gives new messages grouped by chat (time, sender, text, `[ref chat/id]`).
- `wa-bridge search "<q>" [--chat <id|name>] [--since 7d] [--limit 50]`.
- `wa-bridge purge --older-than 30d` runs a manual purge and prints the count. It requires the duration.
- `wa-bridge unlink [--keep-data]`
  1. Explains it will log out the linked device from WhatsApp and delete the local session (and all local data unless `--keep-data`).
  2. Requires typing `unlink`.
  3. Requires the daemon to be stopped (or stops it).
  4. Opens the auth DB → a client → `unlink()` (calls logout). If WhatsApp can't be reached, still wipe locally and tell the user to remove the device on the phone manually.
  5. Deletes `auth.db` (and `store.db`, config, exports unless `--keep-data`), removes the keychain key unless `--keep-data`.
  6. Prints a summary.
- Durations: parse `30d`, `12h`, `90m`, or an ISO timestamp. Put this in `src/cli/duration.ts`, tested.

## Structure
`src/cli/index.ts` (with a shebang `#!/usr/bin/env node`, commander program), `src/cli/commands/*.ts` (one per command, each exporting a function taking `(opts, io)` where `io = { out(s), err(s), prompt(q): Promise<string> }` so tests don't touch a real TTY), `src/cli/format.ts` (tables, relative times in the config timezone), `src/cli/open.ts` (shared: open the store read-only for read commands via the keychain → `openEncryptedDb(create:false)`).

## Tests
Command functions with a fake io, a temp project dir, a fake keystore, and fake link/daemon deps: init refuses without the exact phrase · init is idempotent · .gitignore appended once · `--accept` without env refused · status on uninitialised gives exit 2 · new/search/chats output contains refs · purge parses durations · unlink requires the phrase, calls client.unlink once, wipes files, `--keep-data` keeps the store. Duration parser table.

## Acceptance
`npm run check` passes. `npm run build` works and `node dist/cli/index.js --help` lists the commands. Write `.agents/notes/T8.md`.
