import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths, type DataPaths } from '../../src/core/paths.js';
import { ConfigError, loadConfig, loadDepartments, loadPriorities, writeDefaultConfigs } from '../../src/config/index.js';

const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

let root: string;
let p: DataPaths;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wa-config-'));
  p = resolvePaths(root);
  mkdirSync(p.dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(file: string, text: string): void {
  writeFileSync(file, text, 'utf8');
}

describe('loadConfig', () => {
  it('gives defaults and a warning when config.yaml is missing', () => {
    const { config, warnings } = loadConfig(p);
    expect(config).toEqual({
      retentionDays: 30,
      timezone: systemZone,
      includeGroups: true,
      includeDirectChats: false,
      includeChannels: false,
      allowlist: [],
      denylist: [],
      myNames: [],
      maxTextChars: 2000,
      logLevel: 'info',
    });
    expect(warnings.some((w) => w.includes('config.yaml') && /not found/.test(w))).toBe(true);
  });

  it('maps snake_case keys to camelCase', () => {
    put(p.config, [
      'retention_days: 7',
      'timezone: UTC',
      'include_groups: false',
      'include_direct_chats: true',
      'allowlist: ["Project Team", "1203@g.us"]',
      'denylist: [" Spam Group "]',
      'my_names: [Zuhaib, ZA]',
      'max_text_chars: 500',
      'log_level: debug',
    ].join('\n'));
    const { config, warnings } = loadConfig(p);
    expect(config).toEqual({
      retentionDays: 7,
      timezone: 'UTC',
      includeGroups: false,
      includeDirectChats: true,
      includeChannels: false,
      allowlist: ['Project Team', '1203@g.us'],
      denylist: ['Spam Group'],
      myNames: ['Zuhaib', 'ZA'],
      maxTextChars: 500,
      logLevel: 'debug',
    });
    expect(warnings).toEqual([]);
  });

  it('treats empty values as defaults', () => {
    put(p.config, 'retention_days:\ntimezone:\nallowlist:\nlog_level:\n');
    const { config, warnings } = loadConfig(p);
    expect(config.retentionDays).toBe(30);
    expect(config.timezone).toBe(systemZone);
    expect(config.allowlist).toEqual([]);
    expect(config.logLevel).toBe('info');
    expect(warnings).toEqual([]);
  });

  it('throws ConfigError naming the file for invalid values', () => {
    put(p.config, 'retention_days: -1\n');
    expect(() => loadConfig(p)).toThrow(ConfigError);
    expect(() => loadConfig(p)).toThrow(new RegExp(p.config.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    expect(() => loadConfig(p)).toThrow(/retention_days/);
  });

  it('throws ConfigError for a string where a number is needed', () => {
    put(p.config, 'retention_days: "thirty"\n');
    let caught: unknown;
    try {
      loadConfig(p);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).filePath).toBe(p.config);
  });

  it('throws ConfigError for an unknown log level and for broken YAML', () => {
    put(p.config, 'log_level: verbose\n');
    expect(() => loadConfig(p)).toThrow(ConfigError);
    put(p.config, 'retention_days: [1, 2\n');
    expect(() => loadConfig(p)).toThrow(/invalid YAML/);
  });

  it('warns about unknown keys instead of failing', () => {
    put(p.config, 'retention_days: 10\nfavourite_colour: blue\n');
    const { config, warnings } = loadConfig(p);
    expect(config.retentionDays).toBe(10);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/favourite_colour/);
    expect(warnings[0]).toContain(p.config);
  });

  it('falls back to the system zone with a warning for a bad timezone', () => {
    put(p.config, 'timezone: Mars/Olympus_Mons\n');
    const { config, warnings } = loadConfig(p);
    expect(config.timezone).toBe(systemZone);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Mars\/Olympus_Mons/);
  });
});

describe('loadDepartments', () => {
  it('returns [] with a warning when the file is missing', () => {
    const warnings: string[] = [];
    expect(loadDepartments(p, warnings)).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('reads name, keywords and examples', () => {
    put(p.departments, [
      '- name: IT',
      '  keywords: [vpn, password]',
      '  examples:',
      '    - "VPN down hai"',
      '- name: Ops',
    ].join('\n'));
    const warnings: string[] = [];
    expect(loadDepartments(p, warnings)).toEqual([
      { name: 'IT', keywords: ['vpn', 'password'], examples: ['VPN down hai'] },
      { name: 'Ops', keywords: [], examples: [] },
    ]);
    expect(warnings).toEqual([]);
  });

  it('throws ConfigError naming the file for a missing name or a non-list', () => {
    put(p.departments, '- keywords: [a]\n');
    expect(() => loadDepartments(p)).toThrow(ConfigError);
    put(p.departments, 'name: IT\n');
    expect(() => loadDepartments(p)).toThrow(new RegExp(p.departments.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  });
});

describe('loadPriorities', () => {
  it('returns empty lists with a warning when the file is missing', () => {
    const warnings: string[] = [];
    expect(loadPriorities(p, warnings)).toEqual({ critical: [], high: [], low: [] });
    expect(warnings).toHaveLength(1);
  });

  it('reads the three lists', () => {
    put(p.priorities, 'critical:\n  - "ERP down hai"\nhigh: []\nlow:\n  - "thanks"\n');
    const warnings: string[] = [];
    expect(loadPriorities(p, warnings)).toEqual({ critical: ['ERP down hai'], high: [], low: ['thanks'] });
    expect(warnings).toEqual([]);
  });

  it('throws ConfigError naming the file for a wrong type', () => {
    put(p.priorities, 'critical: "just one string"\n');
    expect(() => loadPriorities(p)).toThrow(ConfigError);
  });
});

describe('writeDefaultConfigs', () => {
  it('writes all three templates into the data dir', () => {
    rmSync(p.dataDir, { recursive: true, force: true });
    const written = writeDefaultConfigs(p);
    expect(written.sort()).toEqual([p.config, p.departments, p.priorities].sort());
    expect(readFileSync(p.config, 'utf8')).toContain('retention_days: 30');
  });

  it('does not overwrite existing files unless asked', () => {
    put(p.config, 'retention_days: 5\n');
    const written = writeDefaultConfigs(p);
    expect(written).not.toContain(p.config);
    expect(written.sort()).toEqual([p.departments, p.priorities].sort());
    expect(readFileSync(p.config, 'utf8')).toBe('retention_days: 5\n');

    const overwritten = writeDefaultConfigs(p, { overwrite: true });
    expect(overwritten).toContain(p.config);
    expect(readFileSync(p.config, 'utf8')).toContain('retention_days: 30');
  });
});

describe('shipped templates', () => {
  it('parse with no warnings and no errors', () => {
    writeDefaultConfigs(p);
    const { config, warnings } = loadConfig(p);
    expect(config.retentionDays).toBe(30);
    expect(config.includeGroups).toBe(true);
    expect(config.includeDirectChats).toBe(false);
    expect(config.maxTextChars).toBe(2000);
    expect(config.logLevel).toBe('info');
    expect(config.myNames).toEqual([]);
    expect(warnings).toEqual([]);

    const deps: string[] = [];
    const departments = loadDepartments(p, deps);
    expect(departments.map((d) => d.name)).toEqual(['ERP', 'IT', 'Finance', 'Sales', 'Ops']);
    for (const d of departments) {
      expect(d.keywords.length).toBeGreaterThanOrEqual(3);
      expect(d.keywords.length).toBeLessThanOrEqual(5);
      expect(d.examples).toHaveLength(2);
    }
    expect(deps).toEqual([]);

    const prio: string[] = [];
    const rules = loadPriorities(p, prio);
    expect(rules.critical.length).toBeGreaterThan(0);
    expect(rules.high.length).toBeGreaterThan(0);
    expect(rules.low.length).toBeGreaterThan(0);
    expect(prio).toEqual([]);
  });
});
