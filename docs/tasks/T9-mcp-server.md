# T9 — MCP server (stdio), all tools

**Model tier:** Sonnet · **Depends on:** Phase 1 on main · **Owned files:** `src/mcp/**`, `test/mcp/**`

Library: `@modelcontextprotocol/server` 2.x (orchestrator adds the dependency before launch) with zod v4 schemas. Read its README/typings in node_modules first. Tool list and JSON shapes: PLAN §6. **Implement exactly those shapes.**

## Rules
- The MCP server opens `store.db` via the keychain + `openEncryptedDb(create:false)` (see `src/cli/open.ts`). It **never** imports `src/daemon/wa/**` or `baileys`.
- Reads use the store API only. The only writes are to our store (mark_reviewed, items) and to export files.
- Output is compact JSON (`JSON.stringify` without indentation) in a single text content block. Times are ISO-8601 in the config timezone. Refs look like `chat_id/message_id`.
- Text is truncated per message (`config.maxTextChars`), with per-call limits plus a `truncated` flag.
- Config is re-read on every call (cheap).
- `export_items.path` must resolve inside `projectRoot`, or the call errors. The default is `.wa-bridge/exports/items-<date>.<ext>`. CSV is RFC 4180 with a UTF-8 BOM so Excel shows Urdu correctly.
- `get_status` combines the store account and meta, `readLock` (daemon alive), counts and warnings.
- Errors: return an MCP tool error with a short, actionable message ("not initialised: run `wa-bridge init`", "daemon not running", etc.). Never return a stack trace.
- Entry point: `src/mcp/server.ts` exports `createServer(deps)`. `src/mcp/main.ts` connects stdio. The CLI gets a `wa-bridge mcp` command that runs main. The orchestrator wires that command.

## Tests
Use an in-memory store + a fake clock. Call each tool handler directly and assert the JSON shape. Path traversal on export is rejected. CSV escaping (commas, quotes, newlines, Urdu) works. `get_new_messages` with `last_review` works after `mark_reviewed`.
