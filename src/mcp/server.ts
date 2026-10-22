import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import type { Config, Store } from '../core/contracts.js';
import { resolvePaths, type DataPaths } from '../core/paths.js';
import type { Chat, ItemCategory, StoredMessage } from '../core/types.js';
import { isoInZone, itemRow, writeItemsExport, ExportError } from '../export/index.js';

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
const MAX_RESPONSE_TEXT_CHARS = 80_000;
const DEFAULT_NEW_LIMIT = 300;

type Json = Record<string, unknown>;

// ---------- helpers ----------

/** Truncates by code point so emoji and Urdu letters are never split. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('') + '… [truncated]';
}

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
  if (pool.length === 0) throw new ToolError(`no chat matches "${ref}": call list_chats to see names and ids`);
  const sample = pool.slice(0, 5).map((c) => `${c.name ?? '(no name)'} [${c.id}]`).join('; ');
  throw new ToolError(`"${ref}" matches ${pool.length} chats (${sample}${pool.length > 5 ? '; …' : ''}): use the chat id`);
}

function resolveChatIds(store: Store, refs: string[] | undefined): string[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  return refs.map((r) => resolveChat(store, r).id);
}

function senderLabel(m: StoredMessage): string {
  if (m.isFromMe) return 'me';
  return m.senderName ?? (m.senderId.split('@')[0] ?? m.senderId);
}

function messageJson(m: StoredMessage, c: Ctx): Json {
  return {
    ref: `${m.chatId}/${m.id}`,
    ts: isoInZone(m.ts, c.config.timezone),
    from: senderLabel(m),
    text: m.deleted ? null : m.text === null ? null : clip(m.text, c.config.maxTextChars),
    reply_to: m.quotedId ? `${m.chatId}/${m.quotedId}` : null,
    mentions_me: m.mentionReason !== null,
    media: m.hasMedia ? (m.mediaType ?? 'media') : null,
    edited: m.edited,
    deleted: m.deleted,
  };
}

/** Counts characters of text in messages so one response cannot flood the context. */
class Budget {
  private used = 0;
  exhausted = false;
  take(m: StoredMessage, c: Ctx): boolean {
    const len = Math.min([...(m.text ?? '')].length, c.config.maxTextChars) + 80;
    if (this.used + len > MAX_RESPONSE_TEXT_CHARS && this.used > 0) {
      this.exhausted = true;
      return false;
    }
    this.used += len;
    return true;
  }
}

// ---------- server ----------

function text(payload: Json): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function failure(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ReturnType<typeof text> | ReturnType<typeof failure>>;

export interface CreatedServer {
  server: McpServer;
  /** Direct handler access for tests. */
  handlers: Map<string, ToolHandler>;
}

const READ_ONLY_NOTE = 'Reads wa-bridge\'s local copy of WhatsApp; never contacts WhatsApp.';
const OWN_RECORDS_NOTE = 'Changes only wa-bridge\'s own records, never WhatsApp.';

export function createServer(deps: McpDeps): CreatedServer {
  const paths = resolvePaths(deps.projectRoot);
  const server = new McpServer({ name: 'wa-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  const handlers = new Map<string, ToolHandler>();

  function tool<S extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    description: string,
    schema: S,
    opts: { write: boolean; readOnlyHint: boolean },
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
    server.registerTool(
      name,
      { description, inputSchema: schema as z.ZodObject<z.ZodRawShape>, annotations: { readOnlyHint: opts.readOnlyHint, openWorldHint: false } },
      async (args) => run(args as Record<string, unknown>),
    );
  }

  const optIso = z.string().optional();

  tool('list_chats',
    `List WhatsApp chats with name, type, participant count, last activity and the number of unreviewed messages. Start here to see which chats have news. ${READ_ONLY_NOTE}`,
    z.object({
      filter: z.enum(['groups', 'direct', 'all']).optional().describe('default "groups"'),
      only_active_since: optIso.describe('ISO-8601 time or 7d / 12h; hides quieter chats'),
    }),
    { write: false, readOnlyHint: true },
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
    }),
    { write: false, readOnlyHint: true },
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
          messages.push(messageJson(m, c));
        }
        chats.push({ id: ch.chat.id, name: ch.chat.name, messages });
      }
      return { since: since === 'last_review' ? 'last_review' : isoInZone(since, c.config.timezone), truncated, chats };
    });

  tool('get_messages',
    `Get messages of one chat (id or name). Without "since" returns the latest messages, oldest first. Use to read context around a message. ${READ_ONLY_NOTE}`,
    z.object({
      chat: z.string().describe('chat id or name'),
      since: optIso, until: optIso,
      limit: z.number().int().min(1).optional().describe(`default 100, max ${MAX_LIMIT}`),
    }),
    { write: false, readOnlyHint: true },
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
        messages.push(messageJson(m, c));
      }
      return { chat: { id: chat.id, name: chat.name }, truncated, messages };
    });

  tool('search_messages',
    `Full-text search over stored messages (works with Urdu, Roman Urdu and English). Returns matches with a snippet and chat name; use get_messages for surrounding context. ${READ_ONLY_NOTE}`,
    z.object({
      query: z.string().min(1), chats: z.array(z.string()).optional(), since: optIso,
      limit: z.number().int().min(1).optional().describe(`default 50, max ${MAX_LIMIT}`),
    }),
    { write: false, readOnlyHint: true },
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
        out.push({ chat_name: h.chatName, ...messageJson(h.message, c), snippet: clip(h.snippet, 300) });
      }
      return { truncated, hits: out };
    });

  tool('get_mentions',
    `Get messages that address you (an @-mention, your name in the text, or a reply to you). Default is everything since the last review. Use to find what people asked of you. ${READ_ONLY_NOTE}`,
    z.object({
      since: optIso.describe('ISO-8601 time, 7d / 12h, or "last_review" (default)'),
      limit: z.number().int().min(1).optional().describe(`default 100, max ${MAX_LIMIT}`),
    }),
    { write: false, readOnlyHint: true },
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
        mentions.push({ chat_name: store.getChat(m.chatId)?.name ?? null, reason: m.mentionReason, ...messageJson(m, c) });
      }
      return { truncated, mentions };
    });

  tool('get_chat_info',
    `Get one chat's details and participant list (id or name). Use to learn who is in a group. ${READ_ONLY_NOTE}`,
    z.object({ chat: z.string().describe('chat id or name') }),
    { write: false, readOnlyHint: true },
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
        return text({ account: null, link_status: 'unlinked', daemon_running: running, warnings: [msg] });
      }
      try {
        const store = opened.store;
        const account = store.getAccount();
        const counts = store.counts();
        const lastSync = metaSeconds(store.getMeta('last_sync_at'));
        const link = account?.linkStatus ?? 'unlinked';
        if (link === 'logged_out') warnings.push('WhatsApp logged this device out: run `wa-bridge unlink` then `wa-bridge link`');
        else if (link === 'unlinked') warnings.push('no account linked: run `wa-bridge link`');
        if (!running && link !== 'unlinked') warnings.push('daemon not running: run `wa-bridge daemon start`');
        if (running && lastSync !== null && (c.nowSec - lastSync) / 60 > 60) warnings.push('no sync for more than 60 minutes');
        const iso = (t: number | null | undefined): string | null => (t ? isoInZone(t, c.config.timezone) : null);
        return text({
          account: account ? formatAccount(account.id) : null,
          link_status: link,
          daemon_running: running,
          last_connected_at: iso(account?.lastConnectedAt),
          last_message_at: iso(account?.lastMessageAt),
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
  server.registerTool('get_status', {
    description: 'Check whether the bridge is linked, the daemon is running, how fresh the data is, and any warnings. Call first if results look stale or empty. Local check only; never contacts WhatsApp.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => statusRun({}));

  tool('mark_reviewed',
    `Mark messages up to "until" as reviewed, so get_new_messages stops returning them. Pass "chats" to limit it, otherwise all included chats. ${OWN_RECORDS_NOTE}`,
    z.object({ chats: z.array(z.string()).optional(), until: z.string().describe('ISO-8601 time') }),
    { write: true, readOnlyHint: false },
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
    { write: true, readOnlyHint: false },
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
    { write: false, readOnlyHint: true },
    (a, c, store) => {
      const items = store.listItems({ status: a.status, department: a.department, priority: a.priority, limit: clampLimit(a.limit, 100) });
      return { items: items.map((i) => itemRow(i, c.nowSec, c.config.timezone)) };
    });

  tool('update_item',
    `Set an item's status to open, done or dismissed by its numeric id. ${OWN_RECORDS_NOTE}`,
    z.object({ id: z.number().int(), status: itemStatus }),
    { write: true, readOnlyHint: false },
    (a, _c, store) => {
      const it = store.updateItem(a.id, a.status);
      if (!it) throw new ToolError(`no item with id ${a.id}: call list_items`);
      return { id: it.id, status: it.status };
    });

  tool('export_items',
    'Write saved items to a CSV (Excel-friendly, UTF-8) or JSON file inside the project folder and return its path. Default path is .wa-bridge/exports/items-<date>.<ext>; paths outside the project folder are rejected. Writes a file only; never contacts WhatsApp.',
    z.object({
      format: z.enum(['csv', 'json']), path: z.string().optional().describe('relative to the project folder'),
      status: itemStatus.optional().describe('default "open"'),
    }),
    { write: false, readOnlyHint: false },
    (a, c, store) => {
      const items = store.listItems({ status: a.status ?? 'open' });
      return { ...writeItemsExport({ paths, items, format: a.format, path: a.path, nowMs: deps.now(), timezone: c.config.timezone }) };
    });

  return { server, handlers };
}
