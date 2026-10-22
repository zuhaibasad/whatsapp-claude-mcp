# T9 — MCP server (stdio), all tools

**Model tier:** Sonnet · **Depends on:** Phase 1 on main · **Owned files:** `src/mcp/**`, `src/export/**`, `test/mcp/**`, `test/export/**`, new `src/cli/commands/items.ts`, `src/cli/commands/mcp.ts`, `test/cli/items.test.ts`, and **only the command registration lines** in `src/cli/index.ts`

Library: `@modelcontextprotocol/server` 2.3.1 (installed). Verified API: `import { McpServer } from '@modelcontextprotocol/server'`; `import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'`; `server.registerTool(name, { description, inputSchema: z.object({...}) }, async (args) => ({ content: [{ type: 'text', text }] }))` with zod v4. Also check `serveStdio` in the stdio module. Read its README/typings in node_modules first. Tool list and JSON shapes: PLAN §6. **Implement exactly those shapes.**

## Rules
- The MCP server opens `store.db` via the keychain + `openEncryptedDb(create:false)` (see `src/cli/open.ts`). It **never** imports `src/daemon/wa/**` or `baileys`.
- Reads use the store API only. The only writes are to our store (mark_reviewed, items) and to export files.
- Output is compact JSON (`JSON.stringify` without indentation) in a single text content block. Times are ISO-8601 in the config timezone. Refs look like `chat_id/message_id`.
- Text is truncated per message (`config.maxTextChars`), with per-call limits plus a `truncated` flag.
- Config is re-read on every call (cheap).
- `export_items.path` must resolve inside `projectRoot`, or the call errors. The default is `.wa-bridge/exports/items-<date>.<ext>`. CSV is RFC 4180 with a UTF-8 BOM so Excel shows Urdu correctly.
- `get_status` combines the store account and meta, `readLock` (daemon alive), counts and warnings.
- Errors: return an MCP tool error with a short, actionable message ("not initialised: run `wa-bridge init`", "daemon not running", etc.). Never return a stack trace.
- Entry point: `src/mcp/server.ts` exports `createServer(deps)`. `src/mcp/main.ts` connects stdio. **stdout is the protocol channel**: nothing else may write to stdout (logs go to `.wa-bridge/daemon.log` via `createLogger({file})`, never console.log).
- Put the item export logic (CSV/JSON writer, path check) in `src/export/` so both MCP and CLI use it.
- CLI (you own these): `wa-bridge mcp` (runs the stdio server; `--project` respected), `wa-bridge items [--status open|done|dismissed] [--department X] [--priority P] [--json]`, `wa-bridge items done <id>` / `items dismiss <id>`, and `wa-bridge export --format csv|json [--path p] [--status open]`. Follow the existing CLI patterns in `src/cli/commands/read.ts` (`(opts, io, deps) => Promise<number>`, `openStore`).
- Tool descriptions matter: Claude picks tools by them. One or two precise sentences each, saying what it returns and when to use it. Mention that `mark_reviewed` and items only change wa-bridge's own records, never WhatsApp.

## Tests
Use an in-memory store + a fake clock. Call each tool handler directly and assert the JSON shape. Path traversal on export is rejected. CSV escaping (commas, quotes, newlines, Urdu) works. `get_new_messages` with `last_review` works after `mark_reviewed`.
