// Pure, DOM-free logic for the setup UI. Unit-tested in test/ui.
import type { ChatRow } from '../src/core/contracts.js';
import type { SelectionSummary, SetupOpName, SetupState, SetupStep } from '../src/core/service.js';

export type Tab = 'all' | 'groups' | 'direct';
export type Screen = 'risk' | 'start' | 'qr' | 'syncing' | 'picker' | 'done' | 'error';

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

export function displayName(row: Pick<ChatRow, 'id' | 'name'>): string {
  const n = row.name?.trim();
  if (n) return n;
  return phoneFromJid(row.id) ?? 'Unknown';
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

export function tabCounts(rows: ChatRow[]): Record<Tab, number> {
  let groups = 0;
  for (const r of rows) if (r.type === 'group') groups++;
  return { all: rows.length, groups, direct: rows.length - groups };
}

export function filterRows(rows: ChatRow[], tab: Tab, query: string): ChatRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (tab === 'groups' && r.type !== 'group') return false;
    if (tab === 'direct' && r.type !== 'direct') return false;
    if (!q) return true;
    return displayName(r).toLowerCase().includes(q) || r.id.toLowerCase().includes(q);
  });
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
    const on = selected.has(r.id);
    if (r.type === 'group') { c.groupsTotal++; if (on) c.groupsSelected++; }
    else { c.directTotal++; if (on) c.directSelected++; }
  }
  return c;
}

export function selectionHeader(c: SelectionCounts): string {
  return `Selected ${c.groupsSelected} of ${c.groupsTotal} groups · ${c.directSelected} of ${c.directTotal} direct chats`;
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

