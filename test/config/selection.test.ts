import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isChatIncluded } from '../../src/config/filter.js';
import { loadConfig } from '../../src/config/load.js';
import { computeRules, currentSelection, writeSelection, type ChatChoice } from '../../src/config/selection.js';
import type { Config } from '../../src/core/contracts.js';
import { resolvePaths } from '../../src/core/paths.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const baseCfg: Config = {
  retentionDays: 30, timezone: 'UTC', includeGroups: true, includeDirectChats: false, includeChannels: false,
  allowlist: [], denylist: [], myNames: [], maxTextChars: 2000, logLevel: 'info',
};

function applied(all: ChatChoice[], r: ReturnType<typeof computeRules>): Set<string> {
  const cfg: Config = {
    ...baseCfg,
    includeGroups: r.includeGroups,
    includeDirectChats: r.includeDirectChats,
    allowlist: r.allowlist.map((c) => c.id),
    denylist: r.denylist.map((c) => c.id),
  };
  return new Set(all.filter((c) => isChatIncluded(cfg, c)).map((c) => c.id));
}

const g = (n: number, name: string | null = `G${n}`): ChatChoice => ({ id: `${n}@g.us`, name, type: 'group' });
const d = (n: number, name: string | null = `D${n}`): ChatChoice => ({ id: `${n}@s.whatsapp.net`, name, type: 'direct' });

describe('computeRules', () => {
  it('reproduces the selection exactly (seeded property test)', () => {
    const rand = rng(1234);
    for (let i = 0; i < 200; i++) {
      const all: ChatChoice[] = [];
      const ng = Math.floor(rand() * 12);
      const nd = Math.floor(rand() * 12);
      for (let k = 0; k < ng; k++) all.push(g(k, rand() < 0.2 ? null : `Group ${k % 5}`));
      for (let k = 0; k < nd; k++) all.push(d(k, rand() < 0.2 ? null : `Person ${k % 5}`));
      const p = rand();
      const selected = new Set(all.filter(() => rand() < p).map((c) => c.id));
      const current = { includeGroups: rand() < 0.5, includeDirectChats: rand() < 0.5 };
      const rules = computeRules(all, selected, current);
      expect(applied(all, rules)).toEqual(selected);
    }
  });

  it('all selected -> defaults on, empty lists', () => {
    const all = [g(1), g(2), d(1), d(2)];
    const r = computeRules(all, new Set(all.map((c) => c.id)));
    expect(r).toMatchObject({ includeGroups: true, includeDirectChats: true, allowlist: [], denylist: [] });
  });

  it('none selected -> defaults off, empty lists', () => {
    const r = computeRules([g(1), d(1)], new Set());
    expect(r).toMatchObject({ includeGroups: false, includeDirectChats: false, allowlist: [], denylist: [] });
  });

  it('ties: groups on, direct off', () => {
    const all = [g(1), g(2), d(1), d(2)];
    const r = computeRules(all, new Set([g(1).id, d(1).id]));
    expect(r.includeGroups).toBe(true);
    expect(r.includeDirectChats).toBe(false);
    expect(r.denylist.map((c) => c.id)).toEqual([g(2).id]);
    expect(r.allowlist.map((c) => c.id)).toEqual([d(1).id]);
  });

  it('an empty type keeps its current default', () => {
    const r = computeRules([g(1)], new Set([g(1).id]), { includeGroups: false, includeDirectChats: true });
    expect(r.includeDirectChats).toBe(true);
    expect(r.includeGroups).toBe(true);
  });

  it('currentSelection mirrors isChatIncluded', () => {
    const all = [g(1), d(1), d(2)];
    const cfg = { ...baseCfg, allowlist: ['D2'] };
    expect(currentSelection(cfg, all)).toEqual(new Set([g(1).id, d(2).id]));
  });
});

describe('writeSelection', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-sel-'));
    fs.mkdirSync(resolvePaths(dir).dataDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SAMPLE = [
    '# my settings',
    'retention_days: 14 # keep two weeks',
    '',
    '# groups?',
    'include_groups: true',
    'include_direct_chats: false',
    'allowlist: []',
    'denylist:',
    '  - "Handwritten Unknown" # keep me',
    '  - hisab',
    'my_names: [Zuhaib]',
    '',
  ].join('\n');

  it('keeps other keys and comments, writes id plus name comments', () => {
    const p = resolvePaths(dir);
    fs.writeFileSync(p.config, SAMPLE);
    const all = [g(1, 'Hisab'), g(2, 'LUMS 🎓 گروپ'), d(1, 'Ali'), d(2, 'Bo')];
    const rules = computeRules(all, new Set([g(2).id, d(1).id]));
    const res = writeSelection(p, rules, all);
    const text = fs.readFileSync(p.config, 'utf8');
    expect(text).toContain('# my settings');
    expect(text).toContain('retention_days: 14 # keep two weeks');
    expect(text).toContain('# groups?');
    expect(text).toContain('my_names: [ Zuhaib ]');
    expect(text).toContain('# keep me');
    expect(text).toContain('"1@g.us" # Hisab');
    expect(text).toContain('"1@s.whatsapp.net" # Ali');
    expect(res.keptUnknown).toBe(1);
    // the old name-based entry "hisab" refers to a known chat and is replaced by its id
    expect(text).not.toMatch(/^\s*- hisab/m);
    const { config } = loadConfig(p);
    expect(new Set(all.filter((c) => isChatIncluded(config, c)).map((c) => c.id))).toEqual(new Set([g(2).id, d(1).id]));
    expect(config.denylist).toContain('Handwritten Unknown');
    expect(config.myNames).toEqual(['Zuhaib']);
    expect(config.retentionDays).toBe(14);
  });

  it('is idempotent', () => {
    const p = resolvePaths(dir);
    fs.writeFileSync(p.config, SAMPLE);
    const all = [g(1, 'Hisab'), g(2, 'Other'), d(1, 'Ali'), d(2, 'Bo')];
    const rules = computeRules(all, new Set([g(1).id, d(1).id, d(2).id]));
    writeSelection(p, rules, all);
    const first = fs.readFileSync(p.config, 'utf8');
    writeSelection(p, rules, all);
    expect(fs.readFileSync(p.config, 'utf8')).toBe(first);
    expect(fs.readdirSync(p.dataDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('creates config.yaml when missing and keeps empty lists as []', () => {
    const p = resolvePaths(dir);
    const all = [g(1), d(1)];
    writeSelection(p, computeRules(all, new Set([g(1).id])), all);
    const parsed = parse(fs.readFileSync(p.config, 'utf8')) as Record<string, unknown>;
    expect(parsed).toMatchObject({ include_groups: true, include_direct_chats: false, allowlist: [], denylist: [] });
  });

  it('rejects invalid YAML without touching the file', () => {
    const p = resolvePaths(dir);
    fs.writeFileSync(p.config, 'a: [unclosed');
    expect(() => writeSelection(p, computeRules([], new Set()), [])).toThrow(/invalid YAML/);
    expect(fs.readFileSync(p.config, 'utf8')).toBe('a: [unclosed');
  });
});
