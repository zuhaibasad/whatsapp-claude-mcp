import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { isChatIncluded } from '../../src/config/filter.js';
import { buildChatRows, computeRules, matchesQuery, type ChatChoice } from '../../src/config/selection.js';
import type { Config } from '../../src/core/contracts.js';
import { SqliteStore } from '../../src/store/index.js';

const cfg: Config = {
  retentionDays: 30, timezone: 'UTC', includeGroups: true, includeDirectChats: false, includeChannels: false,
  allowlist: [], denylist: [], myNames: [], maxTextChars: 2000, logLevel: 'info', mediaDownload: true, mediaOcr: true, mediaMaxMb: 500,
};

describe('channels', () => {
  const ch: ChatChoice = { id: '1@newsletter', name: 'News', type: 'channel' };
  it('are filtered by includeChannels, with allow/deny lists on top', () => {
    expect(isChatIncluded(cfg, ch)).toBe(false);
    expect(isChatIncluded({ ...cfg, includeChannels: true }, ch)).toBe(true);
    expect(isChatIncluded({ ...cfg, allowlist: ['News'] }, ch)).toBe(true);
    expect(isChatIncluded({ ...cfg, includeChannels: true, denylist: ['1@newsletter'] }, ch)).toBe(false);
  });

  it('three-type computeRules reproduces the selection (property test)', () => {
    let seed = 7;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 200; i++) {
      const all: ChatChoice[] = [];
      for (const [type, suffix] of [['group', '@g.us'], ['direct', '@s.whatsapp.net'], ['channel', '@newsletter']] as const) {
        const n = Math.floor(rand() * 8);
        for (let k = 0; k < n; k++) all.push({ id: `${k}${suffix}`, name: rand() < 0.2 ? null : `${type}${k % 3}`, type });
      }
      const selected = new Set(all.filter(() => rand() < 0.5).map((c) => c.id));
      const r = computeRules(all, selected, { includeGroups: rand() < 0.5, includeDirectChats: rand() < 0.5, includeChannels: rand() < 0.5 });
      const c: Config = {
        ...cfg, includeGroups: r.includeGroups, includeDirectChats: r.includeDirectChats, includeChannels: r.includeChannels,
        allowlist: r.allowlist.map((x) => x.id), denylist: r.denylist.map((x) => x.id),
      };
      expect(new Set(all.filter((x) => isChatIncluded(c, x)).map((x) => x.id))).toEqual(selected);
    }
  });

  it('a channel tie goes to off', () => {
    const all: ChatChoice[] = [ch, { id: '2@newsletter', name: 'B', type: 'channel' }];
    expect(computeRules(all, new Set([ch.id])).includeChannels).toBe(false);
  });
});

describe('matchesQuery', () => {
  const row = { id: '1@lid', name: 'Ali Khan', phone: '+923001234567' };
  it('matches name, and phone digits in every common spelling', () => {
    expect(matchesQuery(row, 'ali')).toBe(true);
    expect(matchesQuery(row, 'zed')).toBe(false);
    for (const q of ['03001234567', '+92 300 1234567', '923001234567', '300-123', '(0300) 1234567']) {
      expect(matchesQuery(row, q), q).toBe(true);
    }
    expect(matchesQuery(row, '03009999999')).toBe(false);
    expect(matchesQuery({ id: 'x', name: null, phone: null }, '0300')).toBe(false);
    expect(matchesQuery(row, '')).toBe(true);
  });

  it('passes the shared vectors when present', () => {
    const file = path.resolve('test/fixtures/phone-search-vectors.json');
    if (!fs.existsSync(file)) return;
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = (Array.isArray(raw) ? raw : (raw as { vectors?: unknown[] }).vectors ?? []) as {
      phone?: string | null; name?: string | null; id?: string; query?: string; q?: string; match?: boolean; expected?: boolean;
    }[];
    for (const v of list) {
      const want = v.match ?? v.expected;
      if (want === undefined) continue;
      expect(matchesQuery({ id: v.id ?? '', name: v.name ?? null, phone: v.phone ?? null }, v.query ?? v.q ?? ''), JSON.stringify(v)).toBe(want);
    }
  });
});

describe('buildChatRows', () => {
  it('names, phones via LID mapping, activity and unread, newest first', () => {
    const store = new SqliteStore(new Database(':memory:'));
    store.migrate();
    store.upsertChat({ id: '9@lid', type: 'direct', included: false });
    store.touchChatActivity('9@lid', 2000, 4, false);
    store.upsertContact({ id: '9@lid', pushName: 'Zed' });
    store.linkLid('9@lid', '923001234567@s.whatsapp.net');
    store.upsertContact({ id: '923001234567@s.whatsapp.net', savedName: 'Zed Saved' });
    store.upsertChat({ id: '923009999999@s.whatsapp.net', type: 'direct', name: 'Named', lastMessageAt: 1000 });
    store.upsertChat({ id: '5@g.us', type: 'group', name: 'G', lastMessageAt: 3000 });
    store.touchChatActivity('1@newsletter', 10);
    store.upsertChat({ id: '8@lid', type: 'direct' });
    store.upsertContact({ id: '8@lid', verifiedName: 'Biz Inc' });

    const rows = buildChatRows(store, cfg);
    expect(rows.map((r) => r.id)).toEqual(['5@g.us', '9@lid', '923009999999@s.whatsapp.net', '1@newsletter', '8@lid']);
    const lid = rows.find((r) => r.id === '9@lid')!;
    expect(lid).toMatchObject({ name: 'Zed Saved', phone: '+923001234567', lastMessageAt: 2000, unreadCount: 4, type: 'direct', preselected: false });
    expect(rows.find((r) => r.id === '923009999999@s.whatsapp.net')).toMatchObject({ name: 'Named', phone: '+923009999999' });
    expect(rows.find((r) => r.id === '8@lid')).toMatchObject({ name: 'Biz Inc', phone: null, lastMessageAt: null });
    expect(rows.find((r) => r.id === '1@newsletter')).toMatchObject({ type: 'channel', phone: null });
    expect(rows.find((r) => r.id === '5@g.us')?.preselected).toBe(true);
  });
});
