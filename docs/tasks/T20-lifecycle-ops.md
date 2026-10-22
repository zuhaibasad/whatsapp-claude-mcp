# T20 — Lifecycle & operations: Disconnect in the panel, per-chat notes, diagnose, backups before migrations

**Model tier:** Sonnet · **Owned files:** `src/host/**`, `src/mcp/server.ts` (except the message-formatting call sites T18 changes), `src/mcp/setup-tools.ts`, `src/mcp/host.ts`, `src/config/**`, `templates/departments.yaml`, `ui/**`, `skills/**`, and their tests. Read `src/core/service.ts` (`disconnect?`, `diagnose?`, `SetupScreen`, `Diagnosis`) and `src/core/contracts.ts` (`ChatNote`), added by the orchestrator. **Make `disconnect` and `diagnose` required** in `SetupOps` once implemented, and remove the exclusions in `ui/logic.ts` `UiOpName`.

## 1. Disconnect WhatsApp (#4)
Non-technical users can't run `wa-bridge unlink`.
- `HolderCore.disconnect({ keepData })`:
  1. stop the collector;
  2. connect if needed and call the WaClient facade's `unlink()` (the only logout path, already guard-approved);
  3. on failure (offline), still wipe locally and set `error`: "Could not reach WhatsApp; remove the device on your phone: Settings → Linked devices";
  4. clear `auth.db`. If `keepData=false`, also delete `store.db`, the config yamls, exports and the keychain master key, then return to `needs_accept`.
  5. Release nothing else: the lock stays with this process, and the state becomes `needs_accept`/`ready_to_link`.
- **User proof required,** exactly like acceptRisk:
  - Panel: a separate one-time nonce for disconnect, minted per resources/read (`window.__WA_DISCONNECT_NONCE__`).
  - Browser: session + CSRF.
  - The control token alone is refused (403). Test this.
- HTTP route `POST /api/disconnect {keepData}`; app-only tool `setup_disconnect {nonce, keepData}`.
- **UI:** a "Disconnect WhatsApp" link on the Done screen opens a confirmation screen. It has two clear options, "Disconnect and keep my chat history on this computer" and "Disconnect and delete everything", and a final red button. `whatsapp_setup {screen: "disconnect"}` opens it directly. Update `SetupScreen` handling in the UI (`initialScreen` 'disconnect') and in the host's open-setup `screen` param.
- The model-visible tool count stays at 7. Update the `whatsapp_setup` description: "…or screen 'disconnect' when the user wants to disconnect/unlink WhatsApp (the user confirms in the panel)."

## 2. Per-chat notes (#5)
- `departments.yaml` gets an optional `chats:` list of `{ chat, department?, note? }`. Update the template with commented examples, including a Roman-Urdu one.
- `loadChatNotes(paths): ChatNote[]` (zod; unknown keys produce warnings).
- `whatsapp_brief` and `whatsapp_read messages` include `chat_note: { department, note }` per chat when matched by id or case-insensitive name.
- `whatsapp_choose_chats` is **not** used for notes. Claude edits the yaml when the user says "remember that the ERP group is for supplier invoices": add that guidance to `wa-daily-brief` SKILL.md and the instructions (one line, coordinate with T18, which owns instructions.ts; if both touch it, keep your line separate).

## 3. Diagnose (#7)
- `HolderCore.diagnose()` returns `Diagnosis` with checks for:
  - data dir path exists and is not MSIX-redirected (warn if it is under `\Packages\Claude_`);
  - keychain key present;
  - lock holder pid alive;
  - link state;
  - schema version;
  - collector state + `last_live_at`;
  - health meta from T19 (`health_last_frame_at`, `health_reconnects_24h`, `health_last_reason`; read meta keys, they may be absent until T19 merges);
  - proxy (T19's `proxyInfo`, optional import);
  - disk free space of the data dir (warn below 500 MB).

  Each check has `detail` and `fix` in plain language. No secrets and no message text.
- Expose it via `whatsapp_status {diagnose: true}` (no new tool) and `POST /api/diagnose` (control token). Also add a CLI `wa-bridge doctor` that prints the checks.

## 4. Backups before migrations (#8)
- Before `store.migrate()` upgrades an older schema, and before the legacy data-dir migration moves files, copy `store.db`/`auth.db` (after a checkpoint) to `<dataDir>/backups/<ISO>-pre-v<to>/`. They remain encrypted copies with the same key.
- Keep the last 3 backups. Write `meta.last_backup_at`.
- Put this in `src/host/backup.ts` and call it from host startup before the store is opened for migration. You need a way to read the store's current version without migrating; add a small helper in `src/host`.
- Diagnose lists backups.

## Tests
- Disconnect: refused with only the control token; works with a session or a panel nonce; the nonce is single-use; keepData true/false outcomes; the offline path still wipes and sets error. The fake WaClient's `unlink` is called exactly once.
- Chat notes load and match, and appear in the brief.
- Diagnose output has no secrets: assert no key/token/nonce/QR strings.
- The MSIX warning triggers on a `\Packages\Claude_` path.
- Backup created before the v2→v3 upgrade (use a v2 fixture), and rotation keeps 3.
- UI logic: the disconnect screen routing and the two-option confirm.

## Acceptance
`npm run check`, `npm run build`, `npm run build:mcpb` and `npm run smoke:mcpb` pass. Notes in `docs/notes/T20.md`.
