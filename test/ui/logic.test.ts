import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChatRow } from '../../src/core/contracts.js';
import {
  accountLabel, applyToVisible, channelCounts, displayName, filterRows, formatPhone, initialScreenFrom, initialSelection,
  matchesQuery, opensPicker, phoneFromJid, relativeTime, screenFor, screenFromSearch, selectionCounts, selectionHeader,
  shouldPoll, showPermissionsStep, sortRows, subPhone, tabCounts, unreadLabel, unwrap, visibleRange,
} from '../../ui/logic.js';

const row = (id: string, name: string | null, type: 'group' | 'direct' | 'channel', pre = false, extra: Partial<ChatRow> = {}): ChatRow =>
  ({ id, name, type, phone: null, participantCount: null, lastMessageAt: null, unreadCount: null, preselected: pre, ...extra });

const rows: ChatRow[] = [
  row('1@g.us', 'Family 🏡', 'group', true),
  row('2@g.us', 'خاندان کا گروپ', 'group'),
  row('923001@s.whatsapp.net', 'Ali', 'direct'),
  row('923002@s.whatsapp.net', null, 'direct', true),
  row('999@lid', null, 'direct'),
];

describe('ui logic', () => {
  it('display name fallback', () => {
    expect(displayName(rows[3]!)).toBe('+923002');
    expect(displayName(rows[4]!)).toBe('Unknown contact');
    expect(displayName(row('999@lid', null, 'direct', false, { phone: '+923001234567' }))).toBe('+92 300 1234567');
    expect(displayName(rows[1]!)).toBe('خاندان کا گروپ');
    expect(displayName(row('x@g.us', '  ', 'group'))).toBe('Unknown contact');
    expect(phoneFromJid('92300123:12@s.whatsapp.net')).toBe('+92300123');
  });

  it('tab counts and filtering (name and id, case-insensitive)', () => {
    expect(tabCounts(rows)).toEqual({ all: 5, groups: 2, direct: 3, channels: 0 });
    expect(filterRows(rows, 'groups', '')).toHaveLength(2);
    expect(filterRows(rows, 'direct', '')).toHaveLength(3);
    expect(filterRows(rows, 'all', 'FAMILY').map((r) => r.id)).toEqual(['1@g.us']);
    expect(filterRows(rows, 'all', '923001').map((r) => r.id)).toEqual(['923001@s.whatsapp.net']);
    expect(filterRows(rows, 'all', 'خاندان')).toHaveLength(1);
    expect(filterRows(rows, 'direct', 'family')).toHaveLength(0);
  });

  it('select all / none touches only visible rows', () => {
    const start = initialSelection(rows);
    expect([...start].sort()).toEqual(['1@g.us', '923002@s.whatsapp.net']);
    const visible = filterRows(rows, 'direct', '');
    const all = applyToVisible(start, visible, true);
    expect(all.has('1@g.us')).toBe(true);
    expect(all.has('923001@s.whatsapp.net')).toBe(true);
    expect(all.has('2@g.us')).toBe(false);
    const none = applyToVisible(all, visible, false);
    expect([...none]).toEqual(['1@g.us']);
    expect(start.size).toBe(2); // input not mutated
  });

  it('selection header counts', () => {
    const c = selectionCounts(rows, initialSelection(rows));
    expect(c).toEqual({ groupsSelected: 1, groupsTotal: 2, directSelected: 1, directTotal: 3 });
    expect(selectionHeader(c)).toBe('Selected 1 of 2 groups · 1 of 3 direct chats');
  });

  it('relative time', () => {
    expect(relativeTime(null, 1000)).toBe('no messages yet');
    expect(relativeTime(990, 1000)).toBe('just now');
    expect(relativeTime(1000 - 300, 1000)).toBe('5 min ago');
    expect(relativeTime(1000, 8200)).toBe('2h ago');
    expect(relativeTime(0, 3 * 86400)).toBe('3d ago');
    expect(relativeTime(0, 90 * 86400)).toBe('3 mo ago');
  });

  it('state -> screen mapping', () => {
    expect(screenFor('needs_accept')).toBe('risk');
    expect(screenFor('ready_to_link')).toBe('start');
    expect(screenFor('linking')).toBe('qr');
    expect(screenFor('syncing')).toBe('syncing');
    expect(screenFor('choose_chats')).toBe('picker');
    expect(screenFor('done')).toBe('done');
    expect(screenFor('done', true)).toBe('picker');
    expect(screenFor('error')).toBe('error');
    expect(shouldPoll('linking') && shouldPoll('syncing')).toBe(true);
    expect(shouldPoll('done') || shouldPoll('error') || shouldPoll('choose_chats')).toBe(false);
  });

  it('virtual range stays small and in bounds', () => {
    expect(visibleRange(0, 360, 60, 520)).toEqual({ start: 0, end: 12 });
    const mid = visibleRange(6000, 360, 60, 520);
    expect(mid.end - mid.start).toBeLessThan(25);
    expect(visibleRange(10 ** 9, 360, 60, 520).end).toBe(520);
    expect(visibleRange(0, 360, 60, 0)).toEqual({ start: 0, end: 0 });
  });

  it('account label', () => {
    expect(accountLabel({ account: null })).toBe('your phone');
    expect(accountLabel({ account: { id: '92300123:5@s.whatsapp.net', pushName: 'Zed' } })).toBe('Zed (+92300123)');
  });

  it('unwrap tolerates bare or wrapped payloads', () => {
    expect(unwrap('chatRows', { rows })).toBe(rows);
    expect(unwrap('chatRows', rows)).toBe(rows);
    expect(unwrap('submitSelection', { summary: null })).toBeNull();
  });

  it('phone formatting and sub-line phone', () => {
    expect(formatPhone('+923001234567')).toBe('+92 300 1234567');
    expect(formatPhone('+447700900123')).toBe('+447700900123');
    expect(formatPhone('12')).toBeNull();
    expect(formatPhone(null)).toBeNull();
    const named = row('l@lid', 'Ali', 'direct', false, { phone: '+923001234567' });
    expect(subPhone(named)).toBe('+92 300 1234567');
    expect(subPhone(row('l@lid', null, 'direct', false, { phone: '+923001234567' }))).toBeNull(); // phone is already the title
    expect(subPhone(row('g@g.us', 'Fam', 'group'))).toBeNull();
  });

  it('unread label', () => {
    expect(unreadLabel(0)).toBeNull();
    expect(unreadLabel(null)).toBeNull();
    expect(unreadLabel(7)).toBe('7');
    expect(unreadLabel(250)).toBe('99+');
  });

  const mixed: ChatRow[] = [
    row('g1@g.us', 'G old', 'group', false, { lastMessageAt: 100, unreadCount: 0 }),
    row('d1@s.whatsapp.net', 'D newest', 'direct', false, { lastMessageAt: 500, unreadCount: 1 }),
    row('g2@g.us', 'G mid', 'group', false, { lastMessageAt: 300, unreadCount: 9 }),
    row('d2@lid', null, 'direct', false, { lastMessageAt: null, unreadCount: null, phone: '+923001234567' }),
    row('c1@newsletter', 'News', 'channel', false, { lastMessageAt: 400, unreadCount: 50 }),
    row('d3@s.whatsapp.net', 'D mid', 'direct', false, { lastMessageAt: 300, unreadCount: 9 }),
  ];

  it('tab counts keep channels apart', () => {
    expect(tabCounts(mixed)).toEqual({ all: 5, groups: 2, direct: 3, channels: 1 });
    expect(filterRows(mixed, 'channels', '').map((r) => r.id)).toEqual(['c1@newsletter']);
    expect(filterRows(mixed, 'direct', '').some((r) => r.type === 'channel')).toBe(false);
    expect(filterRows(mixed, 'all', '').some((r) => r.type === 'channel')).toBe(false);
    expect(channelCounts(mixed, new Set(['c1@newsletter']))).toEqual({ selected: 1, total: 1 });
    expect(selectionCounts(mixed, new Set())).toEqual({ groupsSelected: 0, groupsTotal: 2, directSelected: 0, directTotal: 3 });
    expect(selectionHeader(selectionCounts(mixed, new Set()), channelCounts(mixed, new Set()))).toContain('0 of 1 channels');
  });

  it('recent sort interleaves All, nulls last; unread-first then recent', () => {
    expect(filterRows(mixed, 'all', '', 'recent').map((r) => r.id)).toEqual(['d1@s.whatsapp.net', 'g2@g.us', 'd3@s.whatsapp.net', 'g1@g.us', 'd2@lid']);
    expect(sortRows(mixed, 'unread').map((r) => r.id)).toEqual(['c1@newsletter', 'g2@g.us', 'd3@s.whatsapp.net', 'd1@s.whatsapp.net', 'g1@g.us', 'd2@lid']);
    expect(mixed[0]!.id).toBe('g1@g.us'); // input not mutated
  });

  it('phone digit search variants (shared vectors)', () => {
    const file = JSON.parse(readFileSync(new URL('../fixtures/phone-search-vectors.json', import.meta.url), 'utf8')) as {
      vectors: { query: string; name: string | null; phone: string | null; match: boolean }[];
    };
    expect(file.vectors.length).toBeGreaterThan(10);
    for (const v of file.vectors) {
      expect(matchesQuery({ id: 'x@lid', name: v.name, phone: v.phone }, v.query), JSON.stringify(v)).toBe(v.match);
    }
    // phone found through the row in the picker, including a leading 0
    expect(filterRows(mixed, 'all', '0300 1234567').map((r) => r.id)).toEqual(['d2@lid']);
  });

  it('initialScreen routing (auto/chats x state)', () => {
    expect(screenFromSearch('?screen=chats')).toBe('chats');
    expect(screenFromSearch('?mock=1')).toBeNull();
    expect(initialScreenFrom({ initialScreen: 'chats' })).toBe('chats');
    expect(initialScreenFrom({ initialScreen: 'auto' })).toBe('auto');
    expect(initialScreenFrom({ initialScreen: 'zzz' })).toBeNull();
    expect(initialScreenFrom(undefined)).toBeNull();
    expect(opensPicker('chats', 'done')).toBe(true);
    expect(opensPicker('chats', 'choose_chats')).toBe(true);
    expect(opensPicker('chats', 'needs_accept')).toBe(false);
    expect(opensPicker('chats', 'linking')).toBe(false);
    expect(opensPicker('chats', 'syncing')).toBe(false);
    expect(opensPicker('auto', 'done')).toBe(false);
    expect(opensPicker(null, 'choose_chats')).toBe(false);
  });

  it('permissions step shows once, only after onboarding save', () => {
    expect(showPermissionsStep('choose_chats', false)).toBe(true);
    expect(showPermissionsStep('choose_chats', true)).toBe(false);
    expect(showPermissionsStep('done', false)).toBe(false); // later visit
    expect(showPermissionsStep(null, false)).toBe(false);
  });
});
