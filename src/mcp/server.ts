import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { computeRules, currentSelection, writeSelection, type ChatChoice } from '../config/selection.js';
import type { Config, Store } from '../core/contracts.js';
import { resolvePaths, type DataPaths } from '../core/paths.js';
import type { Chat, ItemCategory } from '../core/types.js';
import { isoInZone, itemRow, writeItemsExport, ExportError } from '../export/index.js';
import type { HostBridge } from './host.js';
import { Budget, clip, contextBefore, messageJson, withNotice, type Json } from './format.js';
import { PROMPTS, SERVER_INSTRUCTIONS } from './instructions.js';
import { registerSetupUi } from './setup-tools.js';

/** Thrown by tool handlers; the message is shown to Claude as-is, so keep it short and actionable. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface OpenedStore {
  store: Store;
  close(): void;
}

export interface McpDeps {
  projectRoot: string;
  /** Data folder layout. Defaults to resolvePaths(projectRoot) (development mode). */
  paths?: DataPaths;
  /** Returns the setup panel HTML (dist/ui/setup.html), or null if missing. Default reads the built file. */
  readUiHtml?(): string | null;
  /** The collector host, once it is loaded (null/absent before that or in tests). */
  getHost?: () => HostBridge | null;
  /** Milliseconds since epoch. */
  now(): number;
  /** Opens store.db. Must throw ToolError("not initialised: ...") when there is no store. */
  openStore(opts: { write: boolean }): OpenedStore;
  /** Daemon lock probe. */
  readLock(lockFile: string): { pid: number; startedAt: number; alive: boolean } | null;
  /** Event names and ids only. Never message text. */
  log?(event: string, data?: Record<string, unknown>): void;
}

// Limits. Chosen for Roman Urdu / Urdu / English chats with emoji, where one message is usually short.
const MAX_LIMIT = 1000;
const DEFAULT_NEW_LIMIT = 300;

export { clip };

// ---------- helpers ----------

function metaSeconds(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

function parseTime(input: string, nowSec: number, what: string): number {
  const s = input.trim();
  const rel = /^(\d+)\s*([dhm])$/i.exec(s);
  if (rel) return nowSec - Number(rel[1]) * ({ m: 60, h: 3600, d: 86400 }[(rel[2] ?? 'm').toLowerCase()] ?? 60);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new ToolError(`invalid ${what} "${input}": use an ISO-8601 time like 2026-10-21T09:00:00+05:00, or 7d / 12h / 90m`);
  return Math.floor(ms / 1000);
}

function clampLimit(v: number | undefined, def: number): number {
  if (v === undefined) return def;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(v)));
}

function splitRef(ref: string): { chatId: string; messageId: string } {
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) throw new ToolError(`invalid ref "${ref}": expected "chat_id/message_id"`);
  return { chatId: ref.slice(0, i), messageId: ref.slice(i + 1) };
}

function formatAccount(id: string): string {
  const user = id.split('@')[0]?.split(':')[0] ?? id;
  return /^\d+$/.test(user) ? `+${user}` : id;
}

interface Ctx {
  deps: McpDeps;
  paths: DataPaths;
  config: Config;
  nowSec: number;
}

function ctx(deps: McpDeps, paths: DataPaths): Ctx {
  let config: Config;
  try {
    config = loadConfig(paths).config; // re-read every call
  } catch (e) {
    throw new ToolError(`config problem: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { deps, paths, config, nowSec: Math.floor(deps.now() / 1000) };
}

/** Finds a chat by id, exact name (case-insensitive), or a unique name fragment. */
export function resolveChat(store: Store, ref: string): Chat {
  const needle = ref.trim().toLowerCase();
  if (!needle) throw new ToolError('chat must not be empty');
  const all = store.listChats({});
  const byId = all.find((c) => c.id.toLowerCase() === needle);
  if (byId) return byId;
  const exact = all.filter((c) => (c.name ?? '').trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0] as Chat;
  const pool = exact.length > 1 ? exact : all.filter((c) => (c.name ?? '').toLowerCase().includes(needle));
  if (pool.length === 1) return pool[0] as Chat;
  if (pool.length === 0) throw new ToolError(`no chat matches "${ref}": use whatsapp_read action "chats" to see names and ids`);
  const sample = pool.slice(0, 5).map((c) => `${c.name ?? '(no name)'} [${c.id}]`).join('; ');
  throw new ToolError(`"${ref}" matches ${pool.length} chats (${sample}${pool.length > 5 ? '; …' : ''}): use the chat id`);
}

function resolveChatIds(store: Store, refs: string[] | undefined): string[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  return refs.map((r) => resolveChat(store, r).id);
}

// ---------- server ----------

export function text(payload: Json): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function failure(message: string): ToolResult & { isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface ServerOptions {
  /** Force the "client supports MCP Apps" decision (tests). Default: read the client's capabilities. */
  uiSupported?: boolean;
}

export interface CreatedServer {
  server: McpServer;
  /** Direct handler access for tests. */
  handlers: Map<string, ToolHandler>;
}

const READ_ONLY_NOTE = 'Reads wa-bridge\'s local copy of WhatsApp; never contacts WhatsApp.';
const OWN_RECORDS_NOTE = 'Changes only wa-bridge\'s own records, never WhatsApp.';

export function createServer(deps: McpDeps, options: ServerOptions = {}): CreatedServer {
  const paths = deps.paths ?? resolvePaths(deps.projectRoot);
  const server = new McpServer(
    { name: 'wa-bridge', version: '0.2.0' },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const handlers = new Map<string, ToolHandler>();

  function tool<S extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    description: string,
    schema: S,
    opts: { write: boolean; readOnlyHint: boolean; hidden?: boolean },
    fn: (args: z.infer<S>, c: Ctx, store: Store) => Json,
  ): void {
    const run: ToolHandler = async (raw) => {
      let opened: OpenedStore | undefined;
      try {
        const args = schema.parse(raw ?? {});
        const c = ctx(deps, paths);
        opened = deps.openStore({ write: opts.write });
        const out = fn(args, c, opened.store);
        deps.log?.('tool', { name, ok: true });
        return text(out);
      } catch (e) {
        deps.log?.('tool', { name, ok: false, error: e instanceof Error ? e.name : 'unknown' });
        if (e instanceof ToolError || e instanceof ExportError) return failure(e.message);
        if (e instanceof z.ZodError) {
          return failure(`invalid arguments: ${e.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
        }
        return failure(`internal error: ${e instanceof Error ? e.message : 'unknown'}`);
      } finally {
        try {
          opened?.close();
        } catch {
          /* ignore */
        }
      }
    };
    handlers.set(name, run);
    if (opts.hidden) return; // internal building block of a model-visible tool
    server.registerTool(
      name,
      { description, inputSchema: schema as z.ZodObject<z.ZodRawShape>, annotations: { readOnlyHint: opts.readOnlyHint, openWorldHint: false } },
      async (args) => (await run(args as Record<string, unknown>)) as CallToolResult,
    );
  }

  const optIso = z.string().optional();

  tool('list_chats',
    `List WhatsApp chats with name, type, participant count, last activity and the number of unreviewed messages. Start here to see which chats have news. ${READ_ONLY_NOTE}`,
    z.object({
      filter: z.enum(['groups', 'direct', 'all']).optional().describe('default "groups"'),
      only_active_since: optIso.describe('ISO-8601 time or 7d / 12h; hides quieter chats'),
    }),
    { write: false, readOnlyHint: true, hidden: true },
    (a, c, store) => {
      const filter = a.filter ?? 'groups';
      const chats = store.listChats({
        includedOnly: true,
        type: filter === 'all' ? undefined : filter === 'groups' ? 'group' : 'direct',
        activeSince: a.only_active_since ? parseTime(a.only_active_since, c.nowSec, 'only_active_since') : undefined,
      });
      return {
        chats: chats.map((ch) => ({
          id: ch.id, name: ch.name, type: ch.type, participants: ch.participantCount,
          last_message_at: ch.lastMessageAt ? isoInZone(ch.lastMessageAt, c.config.timezone) : null,
          unreviewed: ch.unreviewed, included: ch.included,
        })),
      };
    });

  tool('get_new_messages',
    `Get messages not yet reviewed (default since="last_review"), grouped by chat, oldest first within each chat. Use for a daily catch-up; if "truncated" is true, narrow with chats/since and do NOT mark everything reviewed. ${READ_ONLY_NOTE}`,
    z.object({
      since: optIso.describe('ISO-8601 time, 7d / 12h, or "last_review" (default)'),
      chats: z.array(z.string()).optional().describe('chat ids or names'),
      limit: z.number().int().min(1).optional().describe(`default ${DEFAULT_NEW_LIMIT}, max ${MAX_LIMIT}`),
      with_context: z.boolean().optional().describe('add up to 3 earlier messages per previously reviewed chat'),
    }),
    { write: false, readOnlyHint: true, hidden: true },
    (a, c, store) => {
      const since: number | 'last_review' = !a.since || a.since === 'last_review' ? 'last_review' : parseTime(a.since, c.nowSec, 'since');
      const limit = clampLimit(a.limit, DEFAULT_NEW_LIMIT);
      const res = store.getNewMessages({ since, chatIds: resolveChatIds(store, a.chats), limit });
      const budget = new Budget();
      let truncated = res.truncated;
      const chats: Json[] = [];
      outer: for (const ch of res.chats) {
        const messages: Json[] = [];
        for (const m of ch.messages) {
          if (!budget.take(m, c)) {
            truncated = true;
            if (messages.length > 0) chats.push({ id: ch.chat.id, name: ch.chat.name, messages });
            break outer;
          }
          messages.push(messageJson(m, c, store));
        }
        chats.push({ id: ch.chat.id, name: ch.chat.name, messages });
      }
      if (a.with_context) {
        // Context is optional: added only with the budget left after the new messages (dropped first when truncated).
        for (const ch of chats) {
          const first = res.chats.find((x) => x.chat.id === ch.id)?.messages[0];
          if (first) ch.context_before = contextBefore(store, String(ch.id), first.ts, c, budget);
        }
      }
      return withNotice({ since: since === 'last_review' ? 'last_review' : isoInZone(since, c.config.timezone), truncated, chats });
    });

  tool('get_messages',
    `Get messages of one chat (id or name). Without "since" returns the latest messages, oldest first. Use to read context around a message. ${READ_ONLY_NOTE}`,
    z.object({
      chat: z.string().describe('chat id or name'),
      since: optIso, until: optIso,
      limit: z.number().int().min(1).optional().describe(`default 100, max ${MAX_LIMIT}`),
    }),
    { write: false, readOnlyHint: true, hidden: true },
    (a, c, store) => {
      const chat = resolveChat(store, a.chat);
      if (!chat.included) throw new ToolError(`chat "${chat.name ?? chat.id}" is excluded by your filter settings`);
      const limit = clampLimit(a.limit, 100);
      const since = a.since ? parseTime(a.since, c.nowSec, 'since') : undefined;
      const until = a.until ? parseTime(a.until, c.nowSec, 'until') : undefined;
      let rows = store.getMessages({ chatIds: [chat.id], since, until, limit: limit + 1, order: since === undefined ? 'desc' : 'asc' });
      let truncated = rows.length > limit;
      rows = rows.slice(0, limit);
      if (since === undefined) rows.reverse();
      const budget = new Budget();
      const messages: Json[] = [];
      for (const m of rows) {
        if (!budget.take(m, c)) {
          truncated = true;
          break;
        }
        messages.push(messageJson(m, c, store));
      }
      return withNotice({ chat: { id: chat.id, name: chat.name }, truncated, messages });
    });

  tool('search_messages',
    `Full-text search over stored messages (works with Urdu, Roman Urdu and English). Returns matches with a snippet and chat name; use get_messages for surrounding context. ${READ_ONLY_NOTE}`,
    z.object({
      query: z.string().min(1), chats: z.array(z.string()).optional(), since: optIso,
      limit: z.number().int().min(1).optional().describe(`default 50, max ${MAX_LIMIT}`),
    }),
    { write: false, readOnlyHint: true, hidden: true },
    (a, c, store) => {
      const limit = clampLimit(a.limit, 50);
      const hits = store.searchMessages(a.query, {
        chatIds: resolveChatIds(store, a.chats),
        since: a.since ? parseTime(a.since, c.nowSec, 'since') : undefined,
        limit: limit + 1,
      });
      const budget = new Budget();
      let truncated = hits.length > limit;
      const out: Json[] = [];
      for (const h of hits.slice(0, limit)) {
        if (!budget.take(h.message, c)) {
          truncated = true;
          break;
        }
        out.push({ chat_name: h.chatName, ...messageJson(h.message, c, store), snippet: clip(h.snippet, 300) });
      }
      return withNotice({ truncated, hits: out });
    });

  tool('get_mentions',
    `Get messages that address you (an @-mention, your name in the text, or a reply to you). Default is everything since the last review. Use to find what people asked of you. ${READ_ONLY_NOTE}`,
    z.object({
      since: optIso.describe('ISO-8601 time, 7d / 12h, or "last_review" (default)'),
      limit: z.number().int().min(1).optional().describe(`default 100, max ${MAX_LIMIT}`),
    }),
    { write: false, readOnlyHint: true, hidden: true },
    (a, c, store) => {
      const since: number | 'last_review' = !a.since || a.since === 'last_review' ? 'last_review' : parseTime(a.since, c.nowSec, 'since');
      const limit = clampLimit(a.limit, 100);
      const rows = store.getMentions({ since, limit: limit + 1 });
      let truncated = rows.length > limit;
      const budget = new Budget();
      const mentions: Json[] = [];
      for (const m of rows.slice(0, limit)) {
        if (!budget.take(m, c)) {
          truncated = true;
          break;
        }
        mentions.push({ chat_name: store.getChat(m.chatId)?.name ?? null, reason: m.mentionReason, ...messageJson(m, c, store) });
      }
      return withNotice({ truncated, mentions });
    });

  tool('get_chat_info',
    `Get one chat's details and participant list (id or name). Use to learn who is in a group. ${READ_ONLY_NOTE}`,
    z.object({ chat: z.string().describe('chat id or name') }),
    { write: false, readOnlyHint: true, hidden: true },
    (a, _c, store) => {
      const chat = resolveChat(store, a.chat);
      return {
        id: chat.id, name: chat.name, type: chat.type, included: chat.included,
        participants: store.getParticipants(chat.id).map((p) => ({
          id: p.contactId, name: p.displayName, admin: p.isAdmin,
        })),
      };
    });

  // get_status must work even when nothing is set up, so it handles open errors itself.
  const statusRun: ToolHandler = async () => {
    try {
      const c = ctx(deps, paths);
      const lock = deps.readLock(paths.lockFile);
      const running = lock?.alive === true;
      const warnings: string[] = [];
      let opened: OpenedStore;
      try {
        opened = deps.openStore({ write: false });
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : `cannot open the store: ${e instanceof Error ? e.message : 'unknown'}`;
        return text({
          account: null, link_status: 'unlinked', daemon_running: running, collector: 'not_linked', last_live_at: null,
          warnings: [`WhatsApp is not set up yet. Say: "set up WhatsApp" (I will open the setup panel). (${msg})`],
        });
      }
      try {
        const store = opened.store;
        const account = store.getAccount();
        const counts = store.counts();
        const lastSync = metaSeconds(store.getMeta('last_sync_at'));
        const link = account?.linkStatus ?? 'unlinked';
        const collector = store.getMeta('collector_state') ?? (link === 'unlinked' ? 'not_linked' : 'stopped');
        const lastLive = metaSeconds(store.getMeta('last_live_at'));
        if (link === 'logged_out' || collector === 'logged_out') warnings.push('WhatsApp logged this device out. Say: "set up WhatsApp" to link it again.');
        else if (link === 'unlinked') warnings.push('No WhatsApp account is linked. Say: "set up WhatsApp" (I will open the setup panel).');
        if (!running && link !== 'unlinked') warnings.push('The collector is not running (it runs while Claude is open); data may be old. It starts when Claude starts the wa-bridge connector.');
        else if (running && link !== 'unlinked' && collector !== 'live') warnings.push(`The collector is ${collector}: recent messages may still be arriving. Call whatsapp_status with wait_for_sync_seconds before a brief.`);
        if (running && lastSync !== null && (c.nowSec - lastSync) / 60 > 60) warnings.push('no sync for more than 60 minutes');
        const iso = (t: number | null | undefined): string | null => (t ? isoInZone(t, c.config.timezone) : null);
        return text({
          account: account ? formatAccount(account.id) : null,
          link_status: link,
          daemon_running: running,
          last_connected_at: iso(account?.lastConnectedAt),
          last_message_at: iso(account?.lastMessageAt),
          collector,
          last_live_at: iso(lastLive),
          minutes_since_sync: lastSync === null ? null : Math.max(0, Math.round((c.nowSec - lastSync) / 60)),
          counts: { chats_included: counts.chatsIncluded, messages: counts.messages, open_items: counts.openItems },
          warnings,
        });
      } finally {
        opened.close();
      }
    } catch (e) {
      return failure(e instanceof ToolError ? e.message : `internal error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  };
  handlers.set('get_status', statusRun);

  tool('whatsapp_mark_reviewed',
    `Mark messages up to "until" (ISO time; use the newest message you read) as reviewed so the next brief skips them. Optional "chats" (ids or names) limits it. ${OWN_RECORDS_NOTE}`,
    z.object({ chats: z.array(z.string()).optional(), until: z.string().describe('ISO-8601 time') }),
    { write: true, readOnlyHint: false,  },
    (a, c, store) => {
      const until = parseTime(a.until, c.nowSec, 'until');
      return { updated: store.setReviewed(resolveChatIds(store, a.chats), until) };
    });

  const category = z.enum(['critical', 'mention', 'request', 'fyi']);
  const priority = z.enum(['critical', 'high', 'normal', 'low']);
  const itemStatus = z.enum(['open', 'done', 'dismissed']);

  tool('save_items',
    `Save follow-up items (tasks, requests, critical notes) found in messages. Each item points at a message by ref ("chat_id/message_id") and is de-duplicated per message and category. ${OWN_RECORDS_NOTE}`,
    z.object({
      items: z.array(z.object({
        ref: z.string(), category,
        department: z.string().optional(), priority,
        summary: z.string().min(1).max(2000), requester: z.string().optional(),
      })).min(1).max(200),
    }),
    { write: true, readOnlyHint: false, hidden: true },
    (a, _c, store) => {
      const checked = a.items.map((it) => {
        const { chatId, messageId } = splitRef(it.ref);
        if (!store.getMessage(chatId, messageId)) {
          throw new ToolError(`unknown ref "${it.ref}": copy refs exactly from message results (the message may have been purged)`);
        }
        return {
          chatId, messageId, category: it.category as ItemCategory, department: it.department ?? null,
          priority: it.priority, summary: it.summary, requester: it.requester ?? null,
        };
      });
      return { ...store.saveItems(checked) };
    });

  tool('list_items',
    `List saved follow-up items, oldest first, optionally by status (default all), department or priority. ${OWN_RECORDS_NOTE.replace('Changes only', 'Reads only')}`,
    z.object({
      status: itemStatus.optional(), department: z.string().optional(), priority: priority.optional(),
      limit: z.number().int().min(1).optional().describe(`default 100, max ${MAX_LIMIT}`),
    }),
    { write: false, readOnlyHint: true, hidden: true },
    (a, c, store) => {
      const items = store.listItems({ status: a.status, department: a.department, priority: a.priority, limit: clampLimit(a.limit, 100) });
      return { items: items.map((i) => itemRow(i, c.nowSec, c.config.timezone)) };
    });

  tool('update_item',
    `Set an item's status to open, done or dismissed by its numeric id. ${OWN_RECORDS_NOTE}`,
    z.object({ id: z.number().int(), status: itemStatus }),
    { write: true, readOnlyHint: false, hidden: true },
    (a, _c, store) => {
      const it = store.updateItem(a.id, a.status);
      if (!it) throw new ToolError(`no item with id ${a.id}: use whatsapp_items action "list"`);
      return { id: it.id, status: it.status };
    });

  tool('export_items',
    'Write saved items to a CSV (Excel-friendly, UTF-8) or JSON file inside the project folder and return its path. Default path is .wa-bridge/exports/items-<date>.<ext>; paths outside the project folder are rejected. Writes a file only; never contacts WhatsApp.',
    z.object({
      format: z.enum(['csv', 'json']), path: z.string().optional().describe('relative to the project folder'),
      status: itemStatus.optional().describe('default "open"'),
    }),
    { write: false, readOnlyHint: false, hidden: true },
    (a, c, store) => {
      const items = store.listItems({ status: a.status ?? 'open' });
      return { ...writeItemsExport({ paths, items, format: a.format, path: a.path, nowMs: deps.now(), timezone: c.config.timezone }) };
    });

  // ---------- setup + conversational control ----------

  const plain = (
    name: string,
    description: string,
    schema: z.ZodObject<z.ZodRawShape>,
    annotations: { readOnlyHint: boolean; hidden?: boolean },
    fn: (args: Record<string, unknown>) => Promise<ToolResult>,
    meta?: Record<string, unknown>,
  ): void => {
    const run: ToolHandler = async (raw) => {
      try {
        return await fn(schema.parse(raw ?? {}) as Record<string, unknown>);
      } catch (e) {
        deps.log?.('tool', { name, ok: false, error: e instanceof Error ? e.name : 'unknown' });
        if (e instanceof ToolError) return failure(e.message);
        if (e instanceof z.ZodError) return failure(`invalid arguments: ${e.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
        return failure(`internal error: ${e instanceof Error ? e.message : 'unknown'}`);
      }
    };
    handlers.set(name, run);
    if (annotations.hidden) return;
    const config = { description, inputSchema: schema, annotations: { readOnlyHint: annotations.readOnlyHint, openWorldHint: false } };
    if (meta) registerAppTool(server, name, { ...config, _meta: meta }, async (args: unknown) => (await run(args as Record<string, unknown>)) as CallToolResult);
    else server.registerTool(name, config, async (args) => (await run(args as Record<string, unknown>)) as CallToolResult);
  };

  // The host module loads in the background after the MCP handshake (it pulls in the WhatsApp library),
  // so a call that arrives right after startup waits briefly instead of failing.
  const needHost = async (waitMs = 20_000): Promise<HostBridge> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const h = deps.getHost?.();
      if (h) return h;
      if (!deps.getHost || Date.now() >= deadline) {
        throw new ToolError('the WhatsApp collector is still starting: try again in a few seconds');
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  plain('wait_for_sync',
    'Wait until the collector has caught up with WhatsApp.',
    z.object({ timeout_seconds: z.number().int().min(1).max(300).optional() }),
    { readOnlyHint: true, hidden: true },
    async (a) => {
      const secs = typeof a.timeout_seconds === 'number' ? a.timeout_seconds : 60;
      const r = await (await needHost()).ops().waitForSync(secs * 1000);
      return text({
        collector: r.collector, ready: r.collector === 'live', waited_seconds: Math.round(r.waitedMs / 1000),
        note: r.collector === 'live' ? 'up to date' : r.collector === 'not_linked' || r.collector === 'logged_out' ? 'WhatsApp is not linked: say "set up WhatsApp"' : 'not fully caught up yet: results may be incomplete',
      });
    });

  // ---------- the model-visible tools that group the handlers above ----------

  const parseOut = (r: ToolResult): Json => {
    try {
      return JSON.parse(r.content[0]?.text ?? '{}') as Json;
    } catch {
      return {};
    }
  };
  const inner = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const h = handlers.get(name);
    if (!h) throw new ToolError(`internal error: no handler ${name}`);
    return h(args);
  };
  const compact = (o: Json): Json => {
    const keep: Json = {};
    for (const k of ['account', 'link_status', 'collector', 'minutes_since_sync', 'warnings']) keep[k] = o[k];
    return keep;
  };
  /** Waits for the collector to go live. Returns null (and a reason) when the host is not available. */
  const trySync = async (secs: number): Promise<{ sync: Json | null; warning?: string }> => {
    try {
      const r = await (await needHost(5_000)).ops().waitForSync(secs * 1000);
      return { sync: { collector: r.collector, ready: r.collector === 'live', waited_seconds: Math.round(r.waitedMs / 1000) } };
    } catch {
      return { sync: null, warning: 'could not wait for the collector (it is still starting or not running); data may be incomplete' };
    }
  };
  const notLinked = (s: Json): boolean => s.link_status === undefined || s.link_status === 'unlinked' || s.link_status === 'logged_out';
  const pickFrom = (a: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const k of keys) if (a[k] !== undefined) o[k] = a[k];
    return o;
  };

  plain('whatsapp_status',
    'Check whether WhatsApp is linked, whether the collector is up to date, and any warnings. Optionally waits for the collector to catch up first. Local check only.',
    z.object({ wait_for_sync_seconds: z.number().int().min(0).max(120).optional().describe('default 0') }),
    { readOnlyHint: true },
    async (a) => {
      const secs = typeof a.wait_for_sync_seconds === 'number' ? a.wait_for_sync_seconds : 0;
      let res = await statusRun({});
      if (res.isError) return res;
      let out = parseOut(res);
      let sync: Json | null = null;
      let warning: string | undefined;
      if (secs > 0 && !notLinked(out)) {
        ({ sync, warning } = await trySync(secs));
        res = await statusRun({});
        if (res.isError) return res;
        out = parseOut(res);
      }
      if (sync) out.sync = sync;
      if (warning) out.warnings = [...((out.warnings as string[] | undefined) ?? []), warning];
      return text(out);
    });

  plain('whatsapp_brief',
    'Use for any brief, summary, "what\'s new" or "what needs my attention" request. One call: waits for sync, then returns status, new messages since the last review, mentions and the open-item count. Local data only.',
    z.object({
      since: z.string().optional().describe('"last_review" (default), ISO-8601 time, or 7d / 12h'),
      limit: z.number().int().min(1).optional().describe(`max messages, default ${DEFAULT_NEW_LIMIT}`),
      wait_for_sync_seconds: z.number().int().min(0).max(120).optional().describe('default 45'),
    }),
    { readOnlyHint: true },
    async (a) => {
      const secs = typeof a.wait_for_sync_seconds === 'number' ? a.wait_for_sync_seconds : 45;
      let res = await statusRun({});
      if (res.isError) return res;
      let status = parseOut(res);
      if (notLinked(status)) return text(withNotice({ status: compact(status), new_messages: { chats: [], truncated: false }, mentions: [], open_items_count: 0 }));
      if (secs > 0) {
        const { warning } = await trySync(secs);
        res = await statusRun({});
        if (res.isError) return res;
        status = parseOut(res);
        if (warning) status.warnings = [...((status.warnings as string[] | undefined) ?? []), warning];
      }
      const since = a.since ?? 'last_review';
      const nm = await inner('get_new_messages', { since, with_context: true, ...pickFrom(a, 'limit') });
      if (nm.isError) return nm;
      const mn = await inner('get_mentions', { since });
      if (mn.isError) return mn;
      const newMessages = parseOut(nm);
      const present = new Set<string>();
      for (const ch of (newMessages.chats as { messages: { ref: string }[] }[] | undefined) ?? []) for (const m of ch.messages) present.add(m.ref);
      const all = (parseOut(mn).mentions as { ref: string; reason?: string }[] | undefined) ?? [];
      const counts = (status.counts as { open_items?: number } | undefined) ?? {};
      delete newMessages.content_notice; // one top-level notice for the whole brief
      return text(withNotice({
        status: compact(status),
        new_messages: newMessages,
        mentions: all.filter((m) => !present.has(m.ref)),
        mentions_already_in_new_messages: all.filter((m) => present.has(m.ref)).map((m) => ({ ref: m.ref, reason: m.reason })),
        open_items_count: counts.open_items ?? 0,
      }));
    });

  plain('whatsapp_read',
    'Read stored WhatsApp data. action: "chats" (list chats with unreviewed counts), "messages" (one chat; needs chat), "search" (needs query; optional chat), "chat_info" (participants; needs chat). Local data only.',
    z.object({
      action: z.enum(['chats', 'messages', 'search', 'chat_info']),
      chat: z.string().optional().describe('chat id or name'),
      query: z.string().optional(),
      since: z.string().optional().describe('ISO-8601 time or 7d / 12h'),
      until: z.string().optional(),
      limit: z.number().int().min(1).optional().describe(`max ${MAX_LIMIT}`),
      filter: z.enum(['groups', 'direct', 'all']).optional().describe('chats only, default groups'),
    }),
    { readOnlyHint: true },
    async (a) => {
      const act = String(a.action);
      const need = (cond: unknown, what: string): void => {
        if (!cond) throw new ToolError(`whatsapp_read action "${act}" needs ${what}`);
      };
      switch (act) {
        case 'chats':
          return inner('list_chats', { ...pickFrom(a, 'filter'), ...(a.since !== undefined ? { only_active_since: a.since } : {}) });
        case 'messages':
          need(a.chat, '"chat"');
          return inner('get_messages', pickFrom(a, 'chat', 'since', 'until', 'limit'));
        case 'search':
          need(a.query, '"query"');
          return inner('search_messages', { ...pickFrom(a, 'query', 'since', 'limit'), ...(a.chat ? { chats: [a.chat] } : {}) });
        default:
          need(a.chat, '"chat"');
          return inner('get_chat_info', pickFrom(a, 'chat'));
      }
    });

  plain('whatsapp_items',
    'Follow-up items kept by wa-bridge. action: "save" (needs items), "list", "update" (needs id and status), "export" (needs format csv|json). Changes only wa-bridge\'s own records, never WhatsApp.',
    z.object({
      action: z.enum(['save', 'list', 'update', 'export']),
      items: z.array(z.object({
        ref: z.string().describe('chat_id/message_id'), category: z.enum(['critical', 'mention', 'request', 'fyi']),
        department: z.string().optional(), priority: z.enum(['critical', 'high', 'normal', 'low']),
        summary: z.string().min(1).max(2000), requester: z.string().optional(),
      })).min(1).max(200).optional(),
      id: z.number().int().optional(),
      status: z.enum(['open', 'done', 'dismissed']).optional(),
      department: z.string().optional(),
      priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
      format: z.enum(['csv', 'json']).optional(),
      path: z.string().optional().describe('export path inside the project folder'),
    }),
    { readOnlyHint: false },
    async (a) => {
      const act = String(a.action);
      const need = (cond: unknown, what: string): void => {
        if (!cond) throw new ToolError(`whatsapp_items action "${act}" needs ${what}`);
      };
      switch (act) {
        case 'save':
          need(a.items, '"items"');
          return inner('save_items', pickFrom(a, 'items'));
        case 'list':
          return inner('list_items', pickFrom(a, 'status', 'department', 'priority'));
        case 'update':
          need(a.id !== undefined && a.status, '"id" and "status"');
          return inner('update_item', pickFrom(a, 'id', 'status'));
        default:
          need(a.format, '"format" (csv or json)');
          return inner('export_items', pickFrom(a, 'format', 'path', 'status'));
      }
    });

  tool('whatsapp_choose_chats',
    'Only when the user names specific chats to add or remove. If they want to add or remove chats without naming them, or to browse, call whatsapp_setup with screen "chats" instead. Newly added chats collect new messages only. Changes only wa-bridge settings, never WhatsApp.',
    z.object({
      include: z.array(z.string()).optional().describe('chat names or ids to add'),
      exclude: z.array(z.string()).optional().describe('chat names or ids to remove'),
    }),
    { write: false, readOnlyHint: false },
    (a, c, store) => {
      if (!a.include?.length && !a.exclude?.length) throw new ToolError('pass "include" and/or "exclude" with chat names or ids');
      const chats = store.listChats({});
      const all: ChatChoice[] = chats.map((ch) => ({ id: ch.id, name: ch.name, type: ch.type }));
      const before = currentSelection(c.config, all);
      const next = new Set(before);
      const on = (a.include ?? []).map((r) => resolveChat(store, r));
      const off = (a.exclude ?? []).map((r) => resolveChat(store, r));
      on.forEach((ch) => next.add(ch.id));
      off.forEach((ch) => next.delete(ch.id));
      const rules = computeRules(all, next, c.config);
      writeSelection(paths, rules, all);
      const label = (ch: { id: string; name: string | null }): string => ch.name ?? ch.id;
      const turnedOn = chats.filter((ch) => next.has(ch.id) && !before.has(ch.id));
      const turnedOff = chats.filter((ch) => !next.has(ch.id) && before.has(ch.id));
      return {
        turned_on: turnedOn.map(label), turned_off: turnedOff.map(label),
        selected_total: next.size,
        note: turnedOn.length > 0 ? 'Chats turned on only collect new messages from now on; their history is not downloaded again. The collector applies this within about 30 seconds.' : 'The collector applies this within about 30 seconds.',
      };
    });

  registerSetupUi({
    server, deps, handlers, plain, needHost, paths,
    uiSupported: options.uiSupported,
  });

  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description },
      () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text } }] }));
  }

  return { server, handlers };
}

