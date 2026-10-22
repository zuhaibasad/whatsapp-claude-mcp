import type { ChatRow } from '../src/core/contracts.js';
import type { SelectionSummary, SetupState } from '../src/core/service.js';
import { pickHost, type Host } from './host.js';
import { createMockHost } from './dev-mock.js';
import { safeSvg } from './svg.js';
import {
  accountLabel, applyToVisible, channelCounts, displayName, doneSummaryLine, filterRows, initialSelection, opensPicker,
  relativeTime, screenFor, selectionCounts, selectionHeader, shouldPoll, showPermissionsStep, subPhone, tabCounts,
  unreadLabel, visibleRange,
  type Screen, type SelectionCounts, type SortMode, type Tab,
} from './logic.js';

type Child = Node | string | null | undefined;
type Attrs = Record<string, string | boolean | EventListener | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) el.append(c);
  return el;
}

const ROW_H = 60;
const POLL_MS = 2000;

let host: Host;
let state: SetupState | null = null;
let stateAt = 0;
let editing = false;
let doneLocal = false;
let entryChats = false;          // opened straight to the picker ("Add a chat")
let closeVariant = false;        // last save came from a later visit, not first-time setup
let permissionsPending = false;
let permissionsSeen = false;
const mockMode = new URLSearchParams(location.search).get('mock') === '1';
let fatal: string | null = null;
let lastCounts: SelectionCounts | null = null;
let lastSummary: SelectionSummary | null = null;
let shown: Screen | null = null;
let pollTimer: number | undefined;
let tickTimer: number | undefined;
let refreshing = false;

const root = (): HTMLElement => document.getElementById('app') as HTMLElement;

// ---------- state flow ----------

function currentScreen(): Screen {
  if (fatal) return 'error';
  if (!state) return 'syncing';
  if (permissionsPending) return 'permissions';
  if (doneLocal && (state.step === 'done' || state.step === 'choose_chats')) return 'done';
  return screenFor(state.step, editing);
}

function apply(next: SetupState): void {
  state = next;
  stateAt = Date.now();
  route();
}

async function refresh(quiet = true): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await host.call('state');
    fatal = null;
    apply(next);
  } catch (e) {
    // Keep polling quietly if we already show something; otherwise show the error.
    if (!state || !quiet) { fatal = messageOf(e); shown = null; route(); }
  } finally { refreshing = false; }
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.';
}

function route(): void {
  const screen = currentScreen();
  if (screen !== shown) {
    shown = screen;
    renderers[screen]();
    const heading = root().querySelector('h1');
    if (heading) { heading.setAttribute('tabindex', '-1'); (heading as HTMLElement).focus({ preventScroll: true }); }
  } else {
    updaters[screen]?.();
  }
  schedulePoll();
}

function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  if (!state || fatal || !shouldPoll(state.step) || document.visibilityState === 'hidden') return;
  pollTimer = window.setTimeout(() => { void refresh(); }, POLL_MS);
}

async function run(action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (e) { fatal = messageOf(e); shown = null; route(); }
}

// ---------- shared pieces ----------

function card(...kids: Child[]): HTMLElement {
  return h('main', { class: 'card' }, ...kids);
}

function show(...kids: Child[]): void {
  const app = root();
  app.replaceChildren(card(...kids));
  window.clearInterval(tickTimer);
  tickTimer = undefined;
}

function button(label: string, onClick: () => void, kind: 'primary' | 'secondary' | 'link' = 'primary', disabled = false): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn ${kind}`, disabled, onclick: onClick }, label);
}

function spinner(): HTMLElement {
  return h('div', { class: 'spinner', role: 'presentation' });
}

// ---------- screens ----------

const renderers: Record<Screen, () => void> = {
  risk() {
    const check = h('input', { type: 'checkbox', id: 'ack' });
    const accept = button('I accept', () => {
      accept.disabled = true;
      void run(async () => { apply(await host.acceptRisk()); });
    }, 'primary', true);
    check.addEventListener('change', () => { accept.disabled = !check.checked; });
    show(
      h('h1', {}, 'Before you start'),
      h('p', { class: 'lead' }, 'wa-bridge lets Claude read your WhatsApp chats. Please read these points first.'),
      h('ul', { class: 'points' },
        h('li', {}, h('strong', {}, 'This is not an official WhatsApp feature. '), 'It links to your account like an extra device. This is against WhatsApp\'s rules, and your number could be restricted or banned.'),
        h('li', {}, h('strong', {}, 'Other people did not agree. '), 'The people in your chats have not agreed to an AI reading their messages.'),
        h('li', {}, h('strong', {}, 'Messages are sent to Anthropic. '), 'When Claude reads a message, the text goes to Anthropic.'),
        h('li', {}, h('strong', {}, 'It only reads. '), 'wa-bridge never sends messages, never marks them as read, and never shows you as online.'),
        h('li', {}, h('strong', {}, 'Your data stays here. '), 'Everything is kept on this computer, encrypted.'),
      ),
      h('label', { class: 'check' }, check, h('span', {}, 'I understand and want to continue')),
      h('div', { class: 'actions' }, accept),
    );
  },

  start() {
    const go = button('Connect WhatsApp', () => {
      go.disabled = true;
      void run(async () => { apply(await host.call('startLink')); });
    });
    show(
      h('h1', {}, 'Connect your WhatsApp'),
      h('p', { class: 'lead' }, 'Keep your phone nearby. You will scan a code with it in the next step.'),
      h('div', { class: 'actions' }, go),
    );
  },

  qr() {
    show(
      h('h1', {}, 'Scan this code with your phone'),
      h('div', { class: 'qr', id: 'qr', 'aria-live': 'polite' }),
      h('p', { class: 'muted center', id: 'countdown' }),
      h('ol', { class: 'steps' },
        h('li', {}, 'Open WhatsApp on your phone'),
        h('li', {}, 'Tap ', h('strong', {}, 'Settings'), ' (or the menu with three dots)'),
        h('li', {}, 'Tap ', h('strong', {}, 'Linked devices'), ', then ', h('strong', {}, 'Link a device')),
        h('li', {}, 'Point your phone at this code'),
      ),
      h('div', { class: 'actions' }, button('Cancel', () => {
        void run(async () => { apply(await host.call('cancelLink')); });
      }, 'link')),
    );
    qrShown = null;
    updaters.qr?.();
    tickTimer = window.setInterval(() => updaters.qr?.(), 1000);
  },

  syncing() {
    show(
      h('div', { class: 'center' }, spinner()),
      h('h1', { class: 'center' }, 'Getting your chats'),
      h('p', { class: 'lead center', id: 'sync-text', 'aria-live': 'polite' }),
      h('p', { class: 'muted center' }, 'This can take a minute or two. Please keep this window open.'),
    );
    updaters.syncing?.();
  },

  picker() { void renderPicker(); },

  permissions() {
    const finish = (): void => { permissionsPending = false; permissionsSeen = true; closeVariant = entryChats; shown = null; route(); };
    const tip = host.kind === 'app'
      ? h('p', { class: 'lead' }, 'Claude asks before using each WhatsApp tool for the first time. To stop that: open ',
        h('strong', {}, 'Settings → Extensions → WhatsApp Bridge'), ' and set the tools to ', h('strong', {}, 'Always allow'), '.')
      : h('p', { class: 'lead' }, 'When Claude asks to use a wa-bridge tool, choose ', h('em', {}, 'Yes, and don\'t ask again'), '.');
    show(
      h('div', { class: 'tick', 'aria-hidden': 'true' }, '🔔'),
      h('h1', {}, 'One last thing: stop the permission pop-ups'),
      tip,
      h('p', { class: 'muted' }, 'wa-bridge can only read; it never sends anything.'),
      h('div', { class: 'actions split' }, button('Skip', finish, 'link'), button('Got it', finish)),
    );
  },

  done() {
    if (closeVariant) {
      show(
        h('div', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
        h('h1', {}, 'Saved'),
        h('p', { class: 'lead' }, doneSummaryLine(lastCounts)),
        h('p', { class: 'lead' }, 'Done — you can close this panel.'),
        h('p', { class: 'muted' }, 'If you turn on a chat later, Claude will only see messages from that point on.'),
        h('div', { class: 'actions' }, button('Change chats', () => {
          editing = true; doneLocal = false; shown = null; route();
        }, 'link')),
      );
      return;
    }
    const lines: Child[] = [h('p', { class: 'lead' }, doneSummaryLine(lastCounts))];
    if (lastSummary) {
      lines.push(h('ul', { class: 'points compact' },
        h('li', {}, lastSummary.includeGroupsByDefault ? 'New groups will be included automatically.' : 'New groups will not be included.'),
        h('li', {}, lastSummary.includeDirectByDefault ? 'New direct chats will be included automatically.' : 'New direct chats will not be included.'),
      ));
    }
    show(
      h('div', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
      h('h1', {}, 'You\'re all set'),
      h('p', { class: 'lead' }, 'Go back to Claude and ask: ', h('em', {}, '“Give me my WhatsApp brief”')),
      ...lines,
      h('p', { class: 'muted' }, 'If you turn on a chat later, Claude will only see messages from that point on.'),
      h('div', { class: 'actions' }, button('Change chats', () => {
        editing = true; doneLocal = false; shown = null; route();
      }, 'link')),
    );
  },

  error() {
    show(
      h('h1', {}, 'Something went wrong'),
      h('p', { class: 'lead' }, fatal ?? state?.error ?? 'Please try again.'),
      h('div', { class: 'actions' }, button('Try again', () => {
        fatal = null; shown = null; void refresh(false);
      })),
    );
  },
};

let qrShown: string | null = null;

const updaters: Partial<Record<Screen, () => void>> = {
  qr() {
    if (!state) return;
    const box = document.getElementById('qr');
    if (box && state.qrSvg !== qrShown) {
      qrShown = state.qrSvg;
      box.replaceChildren();
      const svg = state.qrSvg ? safeSvg(state.qrSvg) : null;
      if (svg) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'WhatsApp link code'); box.append(svg); }
      else box.append(spinner(), h('p', { class: 'muted' }, 'Getting your code ready…'));
    }
    const cd = document.getElementById('countdown');
    if (cd) {
      if (state.qrExpiresIn == null) cd.textContent = '';
      else {
        const left = Math.max(0, Math.round(state.qrExpiresIn - (Date.now() - stateAt) / 1000));
        cd.textContent = left > 0 ? `A new code will appear in ${left} s` : 'Getting a new code…';
      }
    }
  },
  syncing() {
    const t = document.getElementById('sync-text');
    if (!t || !state) return;
    const s = state.sync;
    t.textContent = `Linked as ${accountLabel(state)} · receiving your chats` + (s ? ` (${s.chats} chats, ${s.messages} messages)` : '…');
  },
};

// ---------- chat picker ----------

interface Picker { rows: ChatRow[]; selected: Set<string>; tab: Tab; query: string; sort: SortMode }
let picker: Picker | null = null;

async function renderPicker(): Promise<void> {
  show(h('div', { class: 'center' }, spinner()), h('p', { class: 'lead center' }, 'Loading your chats…'));
  try {
    const rows = await host.call('chatRows');
    picker = { rows, selected: initialSelection(rows), tab: 'all', query: '', sort: 'recent' };
    if (mockMode) { // dev aid for screenshots: ?mock=1&tab=channels&q=0300&sort=unread
      const q = new URLSearchParams(location.search);
      const t = q.get('tab');
      if (t === 'groups' || t === 'direct' || t === 'channels') picker.tab = t;
      picker.query = q.get('q') ?? '';
      if (q.get('sort') === 'unread') picker.sort = 'unread';
    }
  } catch (e) { fatal = messageOf(e); shown = null; route(); return; }
  buildPicker(picker);
}

function buildPicker(p: Picker): void {
  const header = h('p', { class: 'selected-line', 'aria-live': 'polite' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const list = h('div', { class: 'list', tabindex: '0', role: 'group', 'aria-label': 'Your chats' });
  const spacer = h('div', { class: 'spacer' });
  list.append(spacer);
  const empty = h('p', { class: 'muted center empty' }, 'No chats match your search.');
  let visible: ChatRow[] = [];
  let lastKey = '';

  const drawTabs = (): void => {
    const counts = tabCounts(p.rows);
    const defs: [Tab, string][] = [['all', 'All'], ['groups', 'Groups'], ['direct', 'Direct'], ['channels', 'Channels']];
    tabsEl.replaceChildren(...defs.map(([t, label]) => h('button', {
      type: 'button', role: 'tab', class: `tab${p.tab === t ? ' on' : ''}`, 'aria-selected': String(p.tab === t),
      onclick: () => { p.tab = t; list.scrollTop = 0; refilter(); },
    }, `${label} `, h('span', { class: 'count' }, String(counts[t])))));
  };
  const drawHeader = (): void => { header.textContent = selectionHeader(selectionCounts(p.rows, p.selected), channelCounts(p.rows, p.selected)); };

  const drawRows = (force = false): void => {
    const vh = list.clientHeight || 360;
    const { start, end } = visibleRange(list.scrollTop, vh, ROW_H, visible.length);
    const key = `${start}:${end}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    const now = Math.floor(Date.now() / 1000);
    const nodes: HTMLElement[] = [];
    for (let i = start; i < end; i++) {
      const r = visible[i];
      if (!r) continue;
      const cb = h('input', { type: 'checkbox', checked: p.selected.has(r.id), 'aria-label': `Include ${displayName(r)}` });
      cb.addEventListener('change', () => {
        if (cb.checked) p.selected.add(r.id); else p.selected.delete(r.id);
        drawHeader();
      });
      const members = r.type === 'group' && r.participantCount != null ? `${r.participantCount} members · ` : '';
      const phone = subPhone(r);
      const badge = unreadLabel(r.unreadCount);
      nodes.push(h('label', { class: 'row', style: `top:${i * ROW_H}px;height:${ROW_H}px` },
        cb,
        h('span', { class: 'icon', 'aria-hidden': 'true' }, r.type === 'group' ? '👥' : r.type === 'channel' ? '📢' : '👤'),
        h('span', { class: 'meta' },
          h('span', { class: 'name', dir: 'auto' }, displayName(r)),
          h('span', { class: 'sub' }, members + (phone ? `${phone} · ` : '') + relativeTime(r.lastMessageAt, now))),
        badge ? h('span', { class: 'badge', 'aria-label': `${r.unreadCount} unread` }, badge) : null,
      ));
    }
    spacer.replaceChildren(...nodes);
  };

  const refilter = (): void => {
    visible = filterRows(p.rows, p.tab, p.query, p.sort);
    spacer.style.height = `${visible.length * ROW_H}px`;
    empty.hidden = visible.length > 0;
    drawTabs();
    drawRows(true);
  };

  let raf = 0;
  list.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; drawRows(); });
  });

  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search name or number', 'aria-label': 'Search chats', dir: 'auto' });
  search.addEventListener('input', () => { p.query = search.value; list.scrollTop = 0; refilter(); });

  const sortBtns = h('span', { class: 'sort-btns' });
  const drawSort = (): void => {
    const defs: [SortMode, string][] = [['recent', 'Recent'], ['unread', 'Unread first']];
    sortBtns.replaceChildren(...defs.map(([m, label]) => h('button', {
      type: 'button', class: `seg${p.sort === m ? ' on' : ''}`, 'aria-pressed': String(p.sort === m),
      onclick: () => { p.sort = m; list.scrollTop = 0; drawSort(); refilter(); },
    }, label)));
  };

  const bulk = (on: boolean) => (): void => {
    p.selected = applyToVisible(p.selected, visible, on);
    drawHeader(); drawRows(true);
  };

  const save = button('Save', () => { void submit(p, p.selected, save); });
  const skip = button('Skip for now', () => { void submit(p, null, save); }, 'link');

  show(
    h('h1', {}, 'Choose your chats'),
    h('p', { class: 'lead' }, 'Pick the chats Claude is allowed to read. You can change this later.'),
    tabsEl,
    search,
    h('div', { class: 'sortbar' }, h('span', { class: 'muted' }, 'Sort by'), sortBtns),
    h('div', { class: 'bulk' },
      header,
      h('span', { class: 'bulk-btns' },
        button('Select all', bulk(true), 'link'),
        button('Select none', bulk(false), 'link'))),
    h('div', { class: 'list-wrap' }, list, empty),
    h('p', { class: 'muted' }, 'Turning a chat on later only collects new messages from that point on.'),
    h('div', { class: 'actions split' }, skip, save),
  );
  // `show` replaced the DOM, so attach list-dependent drawing after insertion.
  drawHeader();
  drawSort();
  if (p.query) search.value = p.query;
  refilter();
  if (mockMode && new URLSearchParams(location.search).get('autosave') === '1') save.click();
}

async function submit(p: Picker, ids: Set<string> | null, saveBtn: HTMLButtonElement): Promise<void> {
  saveBtn.disabled = true;
  await run(async () => {
    const stepBefore = state?.step ?? null;
    const summary = await host.call('submitSelection', ids ? [...ids] : null);
    lastSummary = summary;
    lastCounts = summary ? summary : ids ? selectionCounts(p.rows, ids) : null;
    editing = false; doneLocal = true; shown = null;
    permissionsPending = showPermissionsStep(stepBefore, permissionsSeen);
    closeVariant = !permissionsPending && (entryChats || stepBefore === 'done');
    const c = lastCounts;
    void host.notifyDone?.(c
      ? `User saved chat selection: ${c.groupsSelected} groups, ${c.directSelected} direct chats.`
      : 'User kept the default chat selection.');
    try { state = await host.call('state'); stateAt = Date.now(); } catch { /* keep old state */ }
    route();
  });
}

// ---------- boot ----------

async function boot(): Promise<void> {
  host = mockMode ? createMockHost() : pickHost();
  show(h('div', { class: 'center' }, spinner()), h('p', { class: 'lead center' }, 'Loading…'));
  try {
    await host.init();
  } catch (e) { fatal = messageOf(e); route(); return; }
  window.addEventListener('wa-refresh', () => { // used by the mock jump bar
    editing = false; doneLocal = false; fatal = null; shown = null; void refresh(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state && shouldPoll(state.step)) void refresh(); else schedulePoll();
  });
  await refresh();
  if (state) {
    let initial = null;
    try { initial = await host.initialScreen(); } catch { /* optional */ }
    if (opensPicker(initial, state.step)) { entryChats = true; editing = true; shown = null; route(); }
  } else route();
}

void boot();
