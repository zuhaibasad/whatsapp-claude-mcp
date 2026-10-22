// Mock host for `?mock=1`: walks through every screen with fake data (520 chats incl. emoji and Urdu names).
// A small floating bar jumps between screens. Dev aid only; no network.
import type { ChatRow } from '../src/core/contracts.js';
import type { SelectionSummary, SetupState, SetupStep } from '../src/core/service.js';
import type { Host } from './host.js';

const URDU = ['خاندان کا گروپ', 'دفتر کے دوست', 'امی جان', 'کرکٹ کلب لاہور', 'محلے کی کمیٹی', 'احمد بھائی'];
const LATIN = ['Family', 'Work team', 'Football 5-a-side', 'Book club', 'Neighbours', 'Trip to Hunza', 'Class of 2012', 'Cousins'];
const EMOJI = ['🎉', '🏏', '🍕', '🌙', '💼', '📚'];

function makeRows(n: number): ChatRow[] {
  const now = Math.floor(Date.now() / 1000);
  const rows: ChatRow[] = [];
  for (let i = 0; i < n; i++) {
    const group = i % 6 === 0;
    const pick = i % 3;
    let name: string | null;
    if (pick === 0) name = `${LATIN[i % LATIN.length]} ${EMOJI[i % EMOJI.length]} ${i}`;
    else if (pick === 1) name = `${URDU[i % URDU.length]} ${i}`;
    else name = i % 7 === 0 ? null : `Contact ${i} ${EMOJI[(i + 2) % EMOJI.length]}`;
    rows.push({
      id: group ? `1203630${i}@g.us` : `92300${String(1000000 + i)}@s.whatsapp.net`,
      name, type: group ? 'group' : 'direct',
      participantCount: group ? 3 + (i % 40) : null,
      lastMessageAt: i % 50 === 49 ? null : now - i * 5400,
      preselected: group && i % 12 === 0,
    });
  }
  return rows;
}

function fakeQr(seed: number): string {
  const n = 33;
  let s = seed * 2654435761 >>> 0;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let d = '';
  const finder = (x: number, y: number): boolean => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const on = finder(x, y)
      ? (x % (n - 7) < 7 && y % (n - 7) < 7) && (Math.max(Math.abs((x % (n - 7)) - 3), Math.abs((y % (n - 7)) - 3)) !== 2)
      : rnd() > 0.5;
    if (on) d += `M${x} ${y}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h${n}v${n}H0z"/><path fill="#000000" d="${d}"/></svg>`;
}

export function createMockHost(): Host {
  const wanted = new URLSearchParams(location.search).get('step') as SetupStep | null; // e.g. ?mock=1&step=choose_chats
  let step: SetupStep = wanted ?? 'needs_accept';
  let phaseStart = Date.now();
  let selected: string[] | null = null;
  const rows = makeRows(520);
  const secs = (): number => (Date.now() - phaseStart) / 1000;
  const go = (s: SetupStep): void => { step = s; phaseStart = Date.now(); };

  const snapshot = (): SetupState => {
    if (step === 'linking' && secs() > 12) go('syncing');
    if (step === 'syncing' && secs() > 8) go('choose_chats');
    const linked = step === 'syncing' || step === 'choose_chats' || step === 'done';
    const t = secs();
    return {
      step,
      qrSvg: step === 'linking' ? fakeQr(Math.floor(t / 6)) : null,
      qrExpiresIn: step === 'linking' ? 6 - (t % 6) : null,
      account: linked ? { id: '923001234567:12@s.whatsapp.net', pushName: 'Zuhaib' } : null,
      sync: step === 'syncing' ? { chats: Math.floor(t * 60), messages: Math.floor(t * 900) } : linked ? { chats: 520, messages: 7200 } : null,
      collector: linked ? 'live' : 'not_linked',
      error: step === 'error' ? 'We could not reach WhatsApp. Check your internet connection and try again.' : null,
      version: 'mock',
    };
  };

  const bar = document.createElement('div');
  bar.className = 'devbar';
  bar.append('Mock: ');
  for (const [label, s] of [['risk', 'needs_accept'], ['link', 'ready_to_link'], ['qr', 'linking'], ['sync', 'syncing'], ['picker', 'choose_chats'], ['done', 'done'], ['error', 'error']] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => { go(s); window.dispatchEvent(new Event('wa-refresh')); });
    bar.append(b);
  }
  document.body.append(bar);

  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return {
    async init() { await wait(150); },
    async call(op, ...args) {
      await wait(120);
      switch (op) {
        case 'state': return snapshot() as never;
        case 'startLink': go('linking'); return snapshot() as never;
        case 'cancelLink': go('ready_to_link'); return snapshot() as never;
        case 'chatRows': return rows as never;
        case 'submitSelection': {
          selected = (args[0] as string[] | null) ?? null;
          go('done');
          if (!selected) return null as never;
          const g = rows.filter((r) => r.type === 'group');
          const sum: SelectionSummary = {
            groupsSelected: g.filter((r) => selected?.includes(r.id)).length, groupsTotal: g.length,
            directSelected: selected.filter((id) => id.endsWith('@s.whatsapp.net')).length, directTotal: rows.length - g.length,
            includeGroupsByDefault: false, includeDirectByDefault: false,
          };
          return sum as never;
        }
      }
    },
    async acceptRisk() { await wait(200); go('ready_to_link'); return snapshot(); },
    async notifyDone(summary) { console.info('[mock] notifyDone:', summary); },
  };
}
