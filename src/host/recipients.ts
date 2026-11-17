// Who whatsapp_send_direct may message when the ref is not a stored message: someone the user already knows on
// WhatsApp. That is an existing 1-to-1 chat, a saved contact, or a member/poster of a stored group. Never a cold
// number nobody in the store knows (user decision, docs/DECISIONS.md 2026-11-17). Ambiguity is refused, never guessed.
import type { ChatRow } from '../core/contracts.js';
import type { Contact } from '../core/types.js';
import type { GroupPerson } from '../store/store.js';
import { HostError } from './types.js';

const DIRECT_JID = /^[\w.:-]+@(s\.whatsapp\.net|lid)$/;
const digitsOf = (s: string): string => s.replace(/\D/g, '');
const norm = (s: string): string => s.trim().toLowerCase();

export interface Recipient {
  /** Best JID to send to: phone JID when known, else the LID. */
  id: string;
  name: string | null;
  /** How the user knows them, shown in the confirmation: "existing chat", "saved contact", "member of X", "posted in X". */
  how: string;
}

interface Person {
  ids: Set<string>;
  phoneJid: string | null;
  lid: string | null;
  /** Names that must match exactly (case-insensitive). */
  exact: Set<string>;
  /** Names that may also match by a unique fragment: chat names and saved contact names. */
  fragment: Set<string>;
  label: string | null;
  how: { rank: number; text: string }[];
}

export interface RecipientSources {
  rows: ChatRow[];
  contacts: Contact[];
  groupPeople: GroupPerson[];
  /** Own JIDs (phone and LID): never listed as a group member or poster. */
  self: string[];
}

/** Resolves `query` (JID, phone with leading 0 read as 92, or a name) to one known person. Throws HostError otherwise. */
export function resolveRecipient(src: RecipientSources, query: string): Recipient {
  const q = query.trim();
  if (q === '') throw new HostError(400, 'say who to message: a name or phone number, or the ref of a message they wrote');

  const byAny = new Map<string, Contact>();
  for (const c of src.contacts) for (const k of [c.id, c.phoneJid, c.lid]) if (k && !byAny.has(k)) byAny.set(k, c);
  const people = new Map<string, Person>();
  const self = new Set(src.self);

  const add = (id: string, rank: number, how: string, names: (string | null)[], fragmentNames: (string | null)[] = []): void => {
    if (!DIRECT_JID.test(id)) return;
    const c = byAny.get(id);
    const phoneJid = c?.phoneJid ?? (id.endsWith('@s.whatsapp.net') ? id : null);
    const lid = c?.lid ?? (id.endsWith('@lid') ? id : null);
    if (rank >= 2 && [id, phoneJid, lid].some((x) => x && self.has(x))) return;
    const key = phoneJid ?? lid ?? id;
    let p = people.get(key);
    if (!p) {
      p = { ids: new Set(), phoneJid, lid, exact: new Set(), fragment: new Set(), label: null, how: [] };
      people.set(key, p);
    }
    for (const x of [id, phoneJid, lid, c?.id]) if (x) p.ids.add(x.toLowerCase());
    for (const n of [...names, ...fragmentNames, c?.savedName ?? null, c?.pushName ?? null, c?.verifiedName ?? null]) {
      if (n && n.trim()) p.exact.add(norm(n));
    }
    for (const n of [...fragmentNames, c?.savedName ?? null]) if (n && n.trim()) p.fragment.add(norm(n));
    p.label ??= c?.savedName ?? fragmentNames.find((n) => !!n) ?? names.find((n) => !!n) ?? c?.pushName ?? c?.verifiedName ?? null;
    if (!p.how.some((h) => h.text === how)) p.how.push({ rank, text: how });
  };

  for (const r of src.rows) if (r.type === 'direct') add(r.id, 0, 'existing chat', [], [r.name]);
  for (const c of src.contacts) {
    if (c.savedName) add(c.phoneJid ?? c.lid ?? c.id, 1, 'saved contact', [c.pushName, c.verifiedName], [c.savedName]);
  }
  for (const g of src.groupPeople) {
    const group = g.chatName ?? 'a group';
    add(g.personId, g.source === 'member' ? 2 : 3, g.source === 'member' ? `member of ${group}` : `posted in ${group}`, [g.name]);
  }

  const all = [...people.values()];
  let pool: Person[];
  if (q.includes('@')) {
    pool = all.filter((p) => p.ids.has(q.toLowerCase()));
  } else if (/^[\d\s+\-().]+$/.test(q)) {
    const d = digitsOf(q).replace(/^0/, '92');
    pool = d.length >= 7 ? all.filter((p) => p.phoneJid !== null && digitsOf(p.phoneJid.split('@')[0] ?? '') === d) : [];
  } else {
    const needle = norm(q);
    pool = all.filter((p) => p.exact.has(needle));
    if (pool.length === 0) pool = all.filter((p) => [...p.fragment].some((n) => n.includes(needle)));
  }

  const phoneOf = (p: Person): string | null => (p.phoneJid ? `+${p.phoneJid.split('@')[0]}` : null);
  const howOf = (p: Person): string => [...p.how].sort((a, b) => a.rank - b.rank).slice(0, 2).map((h) => h.text).join('; ');
  if (pool.length === 1) {
    const p = pool[0] as Person;
    return { id: p.phoneJid ?? p.lid ?? ([...p.ids][0] as string), name: p.label, how: howOf(p) };
  }
  if (pool.length === 0) {
    throw new HostError(404, `nobody matches "${q}": only people with an existing chat, saved contacts and members of your stored groups can be messaged (no cold numbers)`);
  }
  const sample = pool.slice(0, 6).map((p) => [p.label ?? '(no name)', phoneOf(p), `(${howOf(p)})`].filter(Boolean).join(' ')).join('; ');
  throw new HostError(409, `"${q}" matches ${pool.length} people: ${sample}${pool.length > 6 ? '; …' : ''}. Ask the user which one, then use the phone number`);
}
