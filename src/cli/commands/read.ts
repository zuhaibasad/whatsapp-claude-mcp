import { resolvePaths } from '../../core/paths.js';
import type { ListChatsQuery } from '../../core/contracts.js';
import { loadConfig } from '../../config/index.js';
import type { CliDeps } from '../deps.js';
import { parseSince, parseDuration } from '../duration.js';
import { formatTs, oneLine, table, truncate } from '../format.js';
import { CliError, type Io } from '../io.js';
import { openStore } from '../open.js';

function safeSince(s: string, nowSec: number): number {
  try {
    return parseSince(s, nowSec);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
}

export interface ChatsOpts {
  project: string;
  json?: boolean;
  all?: boolean;
  direct?: boolean;
  groups?: boolean;
  activeSince?: string;
}

export async function chatsCommand(opts: ChatsOpts, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  const nowSec = Math.floor(deps.now() / 1000);
  const { config } = loadConfig(paths);
  const q: ListChatsQuery = { includedOnly: !opts.all };
  if (opts.direct && !opts.groups) q.type = 'direct';
  if (opts.groups && !opts.direct) q.type = 'group';
  if (opts.activeSince) q.activeSince = safeSince(opts.activeSince, nowSec);

  const { store, close } = openStore(paths, deps, { write: false });
  try {
    const chats = store.listChats(q);
    if (opts.json) {
      io.out(JSON.stringify(chats, null, 2));
      return 0;
    }
    if (chats.length === 0) {
      io.out('No chats.');
      return 0;
    }
    io.out(table(
      ['ID', 'NAME', 'TYPE', 'UNREVIEWED', 'INCLUDED', 'LAST MESSAGE'],
      chats.map((c) => [
        c.id, truncate(c.name ?? '-'), c.type, String(c.unreviewed), c.included ? 'yes' : 'no',
        c.lastMessageAt ? formatTs(c.lastMessageAt, config.timezone) : '-',
      ]),
    ));
    return 0;
  } finally {
    close();
  }
}

export interface NewOpts {
  project: string;
  json?: boolean;
  since?: string;
  limit?: string;
}

function parseLimit(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`Invalid --limit "${v}".`);
  return n;
}

export async function newCommand(opts: NewOpts, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  const nowSec = Math.floor(deps.now() / 1000);
  const { config } = loadConfig(paths);
  const since = opts.since && opts.since !== 'last_review' ? safeSince(opts.since, nowSec) : 'last_review';
  const limit = parseLimit(opts.limit, 200);

  const { store, close } = openStore(paths, deps, { write: false });
  try {
    const res = store.getNewMessages({ since, limit });
    if (opts.json) {
      io.out(JSON.stringify(res, null, 2));
      return 0;
    }
    if (res.chats.length === 0) {
      io.out('No new messages.');
      return 0;
    }
    for (const c of res.chats) {
      io.out(`== ${c.chat.name ?? c.chat.id} (${c.chat.type}) ==`);
      for (const m of c.messages) {
        const who = m.isFromMe ? 'me' : m.senderName ?? m.senderId;
        const text = m.deleted ? '[deleted]' : oneLine(m.text) || (m.hasMedia ? `[${m.mediaType ?? 'media'}]` : '');
        io.out(`${formatTs(m.ts, config.timezone)} ${who}: ${text} [ref ${m.chatId}/${m.id}]`);
      }
      io.out('');
    }
    if (res.truncated) io.out(`(truncated at ${limit} messages; use --limit to see more)`);
    return 0;
  } finally {
    close();
  }
}

export interface SearchOpts {
  project: string;
  json?: boolean;
  chat?: string;
  since?: string;
  limit?: string;
}

export async function searchCommand(query: string, opts: SearchOpts, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  const nowSec = Math.floor(deps.now() / 1000);
  const { config } = loadConfig(paths);
  const since = opts.since ? safeSince(opts.since, nowSec) : undefined;
  const limit = parseLimit(opts.limit, 50);

  const { store, close } = openStore(paths, deps, { write: false });
  try {
    let chatIds: string[] | undefined;
    if (opts.chat) {
      const needle = opts.chat.trim().toLowerCase();
      const found = store.listChats({}).filter((c) => c.id === opts.chat || (c.name ?? '').trim().toLowerCase() === needle);
      if (found.length === 0) throw new CliError(`No chat matches "${opts.chat}". See: chatai chats --all`);
      chatIds = found.map((c) => c.id);
    }
    const hits = store.searchMessages(query, { chatIds, since, limit });
    if (opts.json) {
      io.out(JSON.stringify(hits, null, 2));
      return 0;
    }
    if (hits.length === 0) {
      io.out('No matches.');
      return 0;
    }
    for (const h of hits) {
      const m = h.message;
      const who = m.isFromMe ? 'me' : m.senderName ?? m.senderId;
      io.out(`${formatTs(m.ts, config.timezone)} ${h.chatName ?? m.chatId} | ${who}: ${oneLine(h.snippet)} [ref ${m.chatId}/${m.id}]`);
    }
    return 0;
  } finally {
    close();
  }
}

export async function purgeCommand(opts: { project: string; olderThan?: string }, io: Io, deps: CliDeps): Promise<number> {
  if (!opts.olderThan) throw new CliError('purge requires --older-than <duration>, e.g. --older-than 30d');
  let secs: number;
  try {
    secs = parseDuration(opts.olderThan);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const paths = resolvePaths(opts.project);
  const cutoff = Math.floor(deps.now() / 1000) - secs;
  const { store, close } = openStore(paths, deps, { write: true });
  try {
    const n = store.purgeOlderThan(cutoff);
    io.out(`Purged ${n} message${n === 1 ? '' : 's'} older than ${opts.olderThan} (before ${new Date(cutoff * 1000).toISOString()}).`);
    return 0;
  } finally {
    close();
  }
}
