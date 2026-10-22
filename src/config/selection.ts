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
  allowlist: ChatChoice[];
  denylist: ChatChoice[];
}

export interface TypeDefaults {
  includeGroups: boolean;
  includeDirectChats: boolean;
}

/**
 * Picks, per chat type, the default (on/off) that needs the fewest list entries, then lists the exceptions.
 * Ties go to "on" for groups and "off" for direct chats. A type with no chats keeps `current`.
 * Applying `isChatIncluded` with the result gives exactly `selectedIds` (ids not in `all` are ignored).
 */
export function computeRules(
  all: ChatChoice[],
  selectedIds: ReadonlySet<string>,
  current: TypeDefaults = { includeGroups: true, includeDirectChats: false },
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
  return { includeGroups, includeDirectChats, allowlist, denylist };
}

/** The ids of the chats that the given config includes. Used to pre-check the picker. */
export function currentSelection(cfg: Config, all: ChatChoice[]): Set<string> {
  return new Set(all.filter((c) => isChatIncluded(cfg, c)).map((c) => c.id));
}

/**
 * Every chat in the store as picker rows: newest activity first (never-active last),
 * `preselected` = whether `config` currently includes the chat.
 */
export function buildChatRows(store: Pick<Store, 'listChats'>, config: Config): ChatRow[] {
  const chats = store.listChats({});
  const selected = currentSelection(config, chats);
  return chats
    .map((c): ChatRow => ({
      id: c.id, name: c.name, type: c.type, phone: null, participantCount: c.participantCount,
      lastMessageAt: c.lastMessageAt, unreadCount: null, preselected: selected.has(c.id),
    }))
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
 * Updates include_groups, include_direct_chats, allowlist and denylist in config.yaml. Other keys and comments stay.
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
