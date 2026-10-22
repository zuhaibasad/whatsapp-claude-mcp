// Pure, DOM-free logic for the setup UI. Unit-tested in test/ui.
import type { ChatRow } from '../src/core/contracts.js';
import type { SelectionSummary, SetupOpName, SetupState, SetupStep } from '../src/core/service.js';

export type Tab = 'all' | 'groups' | 'direct' | 'channels';
export type SortMode = 'recent' | 'unread';
export type InitialScreen = 'auto' | 'chats';
export type Screen = 'risk' | 'start' | 'qr' | 'syncing' | 'picker' | 'permissions' | 'done' | 'error';

/** Map the host's setup step to the screen to show. `editing` = user clicked "Change chats" from done. */
export function screenFor(step: SetupStep, editing = false): Screen {
  switch (step) {
    case 'needs_accept': return 'risk';
    case 'ready_to_link': return 'start';
    case 'linking': return 'qr';
    case 'syncing': return 'syncing';
    case 'choose_chats': return 'picker';
    case 'done': return editing ? 'picker' : 'done';
    default: return 'error';
  }
}

/** Steps where we poll state every 2 seconds. */
export function shouldPoll(step: SetupStep): boolean {
  return step === 'linking' || step === 'syncing';
}

/** "+92300…" from a person JID; null when the id carries no usable phone number. */
export function phoneFromJid(jid: string): string | null {
  const at = jid.indexOf('@');
  if (at < 0 || jid.slice(at + 1) !== 's.whatsapp.net') return null;
  const digits = jid.slice(0, at).split(':')[0] ?? '';
  return /^\d{5,}$/.test(digits) ? `+${digits}` : null;
}

/** "+92 300 1234567" for Pakistani numbers, "+<digits>" otherwise; null for no usable number. */
export function formatPhone(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length < 5) return null;
  if (d.startsWith('92') && d.length === 12) return `+92 ${d.slice(2, 5)} ${d.slice(5)}`;
  return `+${d}`;
}

/** Phone for a row: the supplied number, else one parsed from a person JID. */
export function rowPhone(row: Pick<ChatRow, 'id' | 'phone'>): string | null {
  return formatPhone(row.phone ?? phoneFromJid(row.id));
}

export function displayName(row: Pick<ChatRow, 'id' | 'name'> & { phone?: string | null }): string {
  const n = row.name?.trim();
  if (n) return n;
  return rowPhone({ id: row.id, phone: row.phone ?? null }) ?? 'Unknown contact';
}

/** Phone to show under the name (direct chats that have a name). */
export function subPhone(row: Pick<ChatRow, 'id' | 'name' | 'type' | 'phone'>): string | null {
  if (row.type !== 'direct' || !row.name?.trim()) return null;
  return rowPhone(row);
}

export function relativeTime(tsSeconds: number | null, nowSeconds: number): string {
  if (tsSeconds == null) return 'no messages yet';
  const d = Math.max(0, nowSeconds - tsSeconds);
  if (d < 60) return 'just now';
  const m = Math.floor(d / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** All = groups + direct chats (channels are kept apart, they are rarely wanted). */
export function tabCounts(rows: ChatRow[]): Record<Tab, number> {
  let groups = 0, direct = 0, channels = 0;
  for (const r of rows) {
    if (r.type === 'group') groups++;
    else if (r.type === 'channel') channels++;
    else direct++;
  }
  return { all: groups + direct, groups, direct, channels };
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

/** Same rule as the server's matchesQuery: name text, or phone digits (ignoring space, + and -; leading 0 means 92). */
export function matchesQuery(row: Pick<ChatRow, 'id' | 'name' | 'phone'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.name?.toLowerCase().includes(q)) return true;
  if (!/^[\d\s+\-()]+$/.test(q)) return false;
  let qd = digitsOf(q);
  if (!qd) return false;
  if (qd.startsWith('0')) qd = `92${qd.slice(1)}`;
  const phone = digitsOf(row.phone ?? phoneFromJid(row.id) ?? '');
  return phone !== '' && phone.includes(qd);
}

export function sortRows(rows: ChatRow[], mode: SortMode): ChatRow[] {
  const recent = (r: ChatRow): number => r.lastMessageAt ?? -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (mode === 'unread') {
        const u = (b.r.unreadCount ?? 0) - (a.r.unreadCount ?? 0);
        if (u !== 0) return u;
      }
      return recent(b.r) - recent(a.r) || a.i - b.i;
    })
    .map((x) => x.r);
}

export function filterRows(rows: ChatRow[], tab: Tab, query: string, sort: SortMode = 'recent'): ChatRow[] {
  const kept = rows.filter((r) => {
    if (tab === 'all') { if (r.type === 'channel') return false; }
    else if (tab === 'groups' && r.type !== 'group') return false;
    else if (tab === 'direct' && r.type !== 'direct') return false;
    else if (tab === 'channels' && r.type !== 'channel') return false;
    return matchesQuery(r, query);
  });
  return sortRows(kept, sort);
}

/** Select or deselect only the given (visible) rows; others keep their state. Returns a new set. */
export function applyToVisible(selected: ReadonlySet<string>, visible: ChatRow[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const r of visible) { if (on) next.add(r.id); else next.delete(r.id); }
  return next;
}

export function initialSelection(rows: ChatRow[]): Set<string> {
  return new Set(rows.filter((r) => r.preselected).map((r) => r.id));
}

export interface SelectionCounts { groupsSelected: number; groupsTotal: number; directSelected: number; directTotal: number }

export function selectionCounts(rows: ChatRow[], selected: ReadonlySet<string>): SelectionCounts {
  const c = { groupsSelected: 0, groupsTotal: 0, directSelected: 0, directTotal: 0 };
  for (const r of rows) {
    if (r.type === 'channel') continue;
    const on = selected.has(r.id);
    if (r.type === 'group') { c.groupsTotal++; if (on) c.groupsSelected++; }
    else { c.directTotal++; if (on) c.directSelected++; }
  }
  return c;
}

export function channelCounts(rows: ChatRow[], selected: ReadonlySet<string>): { selected: number; total: number } {
  let total = 0, sel = 0;
  for (const r of rows) if (r.type === 'channel') { total++; if (selected.has(r.id)) sel++; }
  return { selected: sel, total };
}

export function selectionHeader(c: SelectionCounts, ch?: { selected: number; total: number }): string {
  const base = `Selected ${c.groupsSelected} of ${c.groupsTotal} groups · ${c.directSelected} of ${c.directTotal} direct chats`;
  return ch && ch.total > 0 ? `${base} · ${ch.selected} of ${ch.total} channels` : base;
}

/** Text for the unread pill: capped so it never gets wide. null = no badge. */
export function unreadLabel(n: number | null | undefined): string | null {
  if (!n || n <= 0) return null;
  return n > 99 ? '99+' : String(n);
}

/** Rows to render for a scroll position (fixed row height), including a buffer on both sides. */
export function visibleRange(scrollTop: number, viewportH: number, rowH: number, total: number, buffer = 6): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const last = Math.ceil((Math.max(0, scrollTop) + viewportH) / rowH);
  return { start: Math.max(0, first - buffer), end: Math.min(total, last + buffer) };
}

export function accountLabel(state: Pick<SetupState, 'account'>): string {
  const a = state.account;
  if (!a) return 'your phone';
  const phone = phoneFromJid(a.id.includes('@') ? a.id : `${a.id}@s.whatsapp.net`);
  if (a.pushName && phone) return `${a.pushName} (${phone})`;
  return a.pushName ?? phone ?? 'your phone';
}

export function doneSummaryLine(c: SelectionCounts | null): string {
  if (!c) return 'Your chat choices are saved.';
  return `${c.groupsSelected} group${c.groupsSelected === 1 ? '' : 's'} and ${c.directSelected} direct chat${c.directSelected === 1 ? '' : 's'} selected.`;
}

export type UiOpName = Exclude<SetupOpName, 'waitForSync' | 'acceptRisk'>;

/** Servers may return the value bare or wrapped (structuredContent must be an object, so arrays are wrapped). */
export function unwrap(op: UiOpName, payload: unknown): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const o = payload as Record<string, unknown>;
    if (op === 'chatRows' && Array.isArray(o.rows)) return o.rows as ChatRow[];
    if (op === 'submitSelection' && 'summary' in o) return (o.summary ?? null) as SelectionSummary | null;
  }
  return payload;
}


/** `?screen=chats` in a URL query string. */
export function screenFromSearch(search: string): InitialScreen | null {
  const v = new URLSearchParams(search).get('screen');
  return v === 'chats' ? 'chats' : null;
}

/** Read `initialScreen` from a tool result's structuredContent. */
export function initialScreenFrom(structured: unknown): InitialScreen | null {
  if (structured && typeof structured === 'object') {
    const v = (structured as Record<string, unknown>).initialScreen;
    if (v === 'chats' || v === 'auto') return v;
  }
  return null;
}

/** Open straight to the picker only when asked to AND the account is linked and past syncing. */
export function opensPicker(initial: InitialScreen | null, step: SetupStep): boolean {
  return initial === 'chats' && (step === 'done' || step === 'choose_chats');
}

/** The "stop the permission pop-ups" step appears once: on the first save of onboarding (step was choose_chats). */
export function showPermissionsStep(stepBeforeSave: SetupStep | null, alreadySeen: boolean): boolean {
  return stepBeforeSave === 'choose_chats' && !alreadySeen;
}
