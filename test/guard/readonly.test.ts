import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_EXCEPTIONS, WRITE_API_DENYLIST, WRITE_API_PATTERNS, isWriteApi } from './denylist.js';
import { formatViolation, scanSource, type RuleId } from './scanner.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function loadFixtures(kind: 'bad' | 'good'): { name: string; virtualFile: string; expect: string[]; text: string }[] {
  const dir = path.join(FIXTURES, kind);
  return readdirSync(dir)
    .filter((n) => n.endsWith('.ts.txt'))
    .sort()
    .map((name) => {
      const text = readFileSync(path.join(dir, name), 'utf8');
      const file = /^\/\/ @file (\S+)/m.exec(text)?.[1];
      const exp = /^\/\/ @expect (.+)$/m.exec(text)?.[1];
      if (!file) throw new Error(`fixture ${kind}/${name} lacks a "// @file <virtual path>" header`);
      if (kind === 'bad' && !exp) throw new Error(`fixture bad/${name} lacks a "// @expect <rule>" header`);
      return { name, virtualFile: file, expect: exp ? exp.split(',').map((s) => s.trim()) : [], text };
    });
}

describe('read-only guard: scan of src/', () => {
  const files = listTs(path.join(ROOT, 'src'));

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('finds no WhatsApp write API, socket bypass, stray logout, or stray baileys import', () => {
    const violations = files.flatMap((f) => {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      return scanSource(rel, readFileSync(f, 'utf8'));
    });
    expect(violations.map(formatViolation), 'READ-ONLY GUARD VIOLATIONS (file:line  name)').toEqual([]);
  });
});

describe('read-only guard: denylist', () => {
  it('contains the exact PLAN section 7 names', () => {
    expect(WRITE_API_DENYLIST).toHaveLength(28);
    for (const n of ['sendMessage', 'readMessages', 'sendPresenceUpdate', 'chatModify', 'downloadMediaMessage', 'requestPlaceholderResend']) {
      expect(WRITE_API_DENYLIST).toContain(n);
    }
    expect(WRITE_API_PATTERNS).toHaveLength(9);
    expect(ALLOWED_EXCEPTIONS).toEqual(['logout']);
  });

  it('matches pattern names and does not match read APIs', () => {
    for (const n of ['groupUpdateSubject', 'groupInviteCode', 'groupAcceptInviteV4', 'updateLastSeenPrivacy', 'newsletterFollow', 'updateProfileName']) {
      expect(isWriteApi(n), n).toBe(true);
    }
    for (const n of ['groupMetadata', 'groupFetchAllParticipating', 'onWhatsApp', 'fetchStatus', 'profilePictureUrl', 'starred', 'logout']) {
      expect(isWriteApi(n), n).toBe(false);
    }
  });
});

describe('read-only guard: scanner self-test (fixtures)', () => {
  const bad = loadFixtures('bad');
  const good = loadFixtures('good');

  it('has a bad fixture for every rule', () => {
    const rules: RuleId[] = [
      'denylist-api',
      'dynamic-socket-access',
      'socket-spread',
      'logout-outside-unlink',
      'baileys-import-outside-wa',
      'download-media-import',
    ];
    const covered = new Set(bad.flatMap((f) => f.expect));
    for (const r of rules) expect(covered.has(r), `no bad fixture for rule ${r}`).toBe(true);
  });

  for (const f of bad) {
    it(`bad/${f.name} is caught (${f.expect.join(', ')})`, () => {
      const v = scanSource(f.virtualFile, f.text);
      expect(v.length).toBeGreaterThan(0);
      for (const rule of f.expect) {
        expect(v.some((x) => x.rule === rule), `expected rule ${rule}; got ${v.map(formatViolation).join(' | ')}`).toBe(true);
      }
      for (const x of v) {
        expect(x.line).toBeGreaterThan(0);
        expect(formatViolation(x)).toContain(`${f.virtualFile}:${x.line}`);
      }
    });
  }

  for (const f of good) {
    it(`good/${f.name} has no violations`, () => {
      expect(scanSource(f.virtualFile, f.text).map(formatViolation)).toEqual([]);
    });
  }

  it('reports each distinct violation in the multi-violation fixtures', () => {
    const find = (n: string) => bad.find((f) => f.name.startsWith(n));
    const names = (n: string) => {
      const f = find(n);
      if (!f) throw new Error(`missing fixture ${n}`);
      return scanSource(f.virtualFile, f.text).map((v) => v.name);
    };
    expect(names('denylist-property-access')).toEqual(expect.arrayContaining(['sendMessage', 'readMessages']));
    expect(names('denylist-destructure')).toEqual(expect.arrayContaining(['readMessages', 'sendPresenceUpdate']));
    expect(names('denylist-element-literal')).toEqual(['sendMessage', 'chatModify']);
    expect(names('denylist-pattern')).toHaveLength(7);
    expect(names('dynamic-socket-access')).toHaveLength(2);
    expect(names('socket-spread')).toHaveLength(5);
    const logout = scanSource('src/daemon/wa/wa-client.ts', find('logout-wrong-function')?.text ?? '');
    expect(logout.filter((v) => v.rule === 'logout-outside-unlink').map((v) => v.line)).toEqual([11, 15]);
    expect(names('baileys-import-outside-wa')).toHaveLength(4);
  });

  it('flags baileys imports outside src/daemon/wa but not inside', () => {
    const src = `import makeWASocket from 'baileys';\nexport default makeWASocket;\n`;
    expect(scanSource('src/daemon/ingest.ts', src).map((v) => v.rule)).toEqual(['baileys-import-outside-wa']);
    expect(scanSource('src/daemon/wa/wa-client.ts', src)).toEqual([]);
    expect(scanSource('src\\mcp\\server.ts', src).map((v) => v.rule)).toEqual(['baileys-import-outside-wa']);
  });
});
