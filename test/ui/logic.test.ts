import { describe, expect, it } from 'vitest';
import type { ChatRow } from '../../src/core/contracts.js';
import {
  accountLabel, applyToVisible, displayName, filterRows, initialSelection, phoneFromJid, relativeTime,
  screenFor, selectionCounts, selectionHeader, shouldPoll, tabCounts, unwrap, visibleRange,
} from '../../ui/logic.js';

const row = (id: string, name: string | null, type: 'group' | 'direct', pre = false): ChatRow =>
  ({ id, name, type, phone: null, participantCount: null, lastMessageAt: null, unreadCount: null, preselected: pre });

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
    expect(displayName(rows[4]!)).toBe('Unknown');
    expect(displayName(rows[1]!)).toBe('خاندان کا گروپ');
    expect(displayName(row('x@g.us', '  ', 'group'))).toBe('Unknown');
    expect(phoneFromJid('92300123:12@s.whatsapp.net')).toBe('+92300123');
  });

  it('tab counts and filtering (name and id, case-insensitive)', () => {
    expect(tabCounts(rows)).toEqual({ all: 5, groups: 2, direct: 3 });
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
});
