// Chat selection: turns a set of chosen chat ids into allowlist/denylist rules and writes them to config.yaml.
import fs from 'node:fs';
import { Document, Scalar, YAMLSeq, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { ChatRow, Config, Store } from '../core/contracts.js';
import type { DataPaths } from '../core/paths.js';
import type { ChatType } from '../core/types.js';
import { isChatIncluded } from './filter.js';

export interface ChatChoice {
  id: string;
  name: string | null;
  type: ChatType;
}

export interface SelectionRules {
  includeGroups: boolean;
  includeDirectChats: boolean;
  includeChannels: boolean;
  allowlist: ChatChoice[];
  denylist: ChatChoice[];
}

export interface TypeDefaults {
  includeGroups: boolean;
  includeDirectChats: boolean;
  includeChannels?: boolean;
}

/**
 * Picks, per chat type, the default (on/off) that needs the fewest list entries, then lists the exceptions.
 * Ties go to "on" for groups and "off" for direct chats and channels. A type with no chats keeps `current`.
 * Applying `isChatIncluded` with the result gives exactly `selectedIds` (ids not in `all` are ignored).
 */
export function computeRules(
  all: ChatChoice[],
  selectedIds: ReadonlySet<string>,
  current: TypeDefaults = { includeGroups: true, includeDirectChats: false, includeChannels: false },
): SelectionRules {
  const allowlist: ChatChoice[] = [];
  const denylist: ChatChoice[] = [];
  const decide = (type: ChatType, keep: boolean): boolean => {
    const chats = all.filter((c) => c.type === type);
    if (chats.length === 0) return keep;
    const selected = chats.filter((c) => selectedIds.has(c.id));
    const twice = selected.length * 2;
    const on = twice > chats.length || (twice === chats.length && type === 'group');
    if (on) denylist.push(...chats.filter((c) => !selectedIds.has(c.id)));
    else allowlist.push(...selected);
    return on;
  };
  const includeGroups = decide('group', current.includeGroups);
  const includeDirectChats = decide('direct', current.includeDirectChats);
  const includeChannels = decide('channel', current.includeChannels ?? false);
  return { includeGroups, includeDirectChats, includeChannels, allowlist, denylist };
}

/** The ids of the chats that the given config includes. Used to pre-check the picker. */
export function currentSelection(cfg: Config, all: ChatChoice[]): Set<string> {
  return new Set(all.filter((c) => isChatIncluded(cfg, c)).map((c) => c.id));
}

const digitsOf = (v: string): string => v.replace(/\D/g, '');

/** "+<digits>" from a phone JID such as 923001234567@s.whatsapp.net (device suffix ignored), else null. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  const m = /^(\d{5,})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '');
  return m ? `+${m[1]}` : null;
}

/**
 * Picker search: case-insensitive substring on name and id, and on phone digits when the query looks like a number
 * (spaces, "+", "-", brackets ignored; a leading 0 is read as 92, so 03001234567 finds +923001234567).
 * Pure and DOM-free; the UI uses the same logic.
 */
export function matchesQuery(row: { name: string | null; phone: string | null; id?: string }, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  if ((row.name ?? '').toLowerCase().includes(needle)) return true;
  if (row.id && row.id.toLowerCase().includes(needle)) return true;
  if (row.phone && /^[\d\s+\-().]+$/.test(needle)) {
    const qd = digitsOf(needle).replace(/^0/, '92');
    if (qd.length > 0 && digitsOf(row.phone).includes(qd)) return true;
  }
  return false;
}

/**
 * Every chat in the store as picker rows: newest activity first (never-active last),
 * `preselected` = whether `config` currently includes the chat.
 * Name: chat name, else the contact's saved / push / verified name. Contact is found by chat id (which may be a LID).
 * Phone: from a phone-JID chat id, else from the contact's phone JID (LID mapping).
 */
export function buildChatRows(store: Pick<Store, 'listChats' | 'getContact'>, config: Config): ChatRow[] {
  const chats = store.listChats({});
  const selected = currentSelection(config, chats);
  return chats
    .map((c): ChatRow => {
      const contact = c.type === 'direct' ? store.getContact(c.id) : null;
      const name = c.name ?? contact?.savedName ?? contact?.pushName ?? contact?.verifiedName ?? null;
      const phone = c.type === 'direct' ? (phoneFromJid(c.id) ?? phoneFromJid(contact?.phoneJid)) : null;
      const last = Math.max(c.lastActivityAt ?? 0, c.lastMessageAt ?? 0);
      return {
        id: c.id, name, type: c.type, phone, participantCount: c.participantCount,
        lastMessageAt: last > 0 ? last : null, unreadCount: c.unreadCount ?? null, preselected: selected.has(c.id),
      };
    })
    .sort((a, b) => (b.lastMessageAt ?? -1) - (a.lastMessageAt ?? -1) || a.id.localeCompare(b.id));
}

export interface WriteSelectionResult {
  file: string;
  allowlistEntries: number;
  denylistEntries: number;
  /** Hand-written entries that match no known chat; they were left in place. */
  keptUnknown: number;
}

const oneLineName = (name: string | null): string => (name ?? '').replace(/\s+/g, ' ').trim();

function entryText(node: unknown): string | null {
  if (isScalar(node) && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value).trim();
  return null;
}

function newEntry(chat: ChatChoice): Scalar {
  const node = new Scalar(chat.id);
  node.type = 'QUOTE_DOUBLE';
  const name = oneLineName(chat.name);
  if (name) node.comment = ` ${name}`;
  return node;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Updates include_groups, include_direct_chats, include_channels, allowlist and denylist in config.yaml. Other keys and comments stay.
 * Existing entries that name a chat in `all` (by id, or by name ignoring case) are replaced; other entries are kept.
 * New entries are chat ids with the chat name as a trailing comment. The file is replaced atomically.
 */
export function writeSelection(paths: DataPaths, rules: SelectionRules, all: ChatChoice[]): WriteSelectionResult {
  const file = paths.config;
  const doc = fs.existsSync(file) ? parseDocument(fs.readFileSync(file, 'utf8')) : new Document({});
  if (doc.errors.length > 0) throw new Error(`${file}: invalid YAML: ${doc.errors[0]?.message ?? 'unknown error'}`);
  if (doc.contents === null || doc.contents === undefined) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new Error(`${file}: expected key: value pairs at the top level`);

  const known = new Set<string>();
  for (const c of all) {
    known.add(c.id);
    const n = c.name?.trim().toLowerCase();
    if (n) known.add(`name:${n}`);
  }
  const refersToKnownChat = (text: string): boolean => known.has(text) || known.has(`name:${text.toLowerCase()}`);

  let keptUnknown = 0;
  const update = (key: string, chats: ChatChoice[]): void => {
    const existing = doc.get(key, true);
    const kept: unknown[] = isSeq(existing)
      ? existing.items.filter((item) => {
          const text = entryText(item);
          return text === null || !refersToKnownChat(text);
        })
      : [];
    keptUnknown += kept.length;
    const items = [...kept, ...chats.map(newEntry)];
    if (isSeq(existing)) {
      existing.items = items;
      existing.flow = items.length === 0;
    } else {
      const seq = new YAMLSeq();
      seq.items = items;
      seq.flow = items.length === 0;
      doc.set(key, seq);
    }
  };

  doc.set('include_groups', rules.includeGroups);
  doc.set('include_direct_chats', rules.includeDirectChats);
  doc.set('include_channels', rules.includeChannels);
  update('allowlist', rules.allowlist);
  update('denylist', rules.denylist);

  fs.mkdirSync(paths.dataDir, { recursive: true });
  writeAtomic(file, doc.toString({ lineWidth: 0 }));
  return {
    file,
    allowlistEntries: rules.allowlist.length,
    denylistEntries: rules.denylist.length,
    keptUnknown,
  };
}
