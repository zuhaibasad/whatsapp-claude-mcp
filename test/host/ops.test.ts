import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUserPaths, type DataPaths } from '../../src/core/paths.js';
import { deriveDbKey, openEncryptedDb } from '../../src/crypto/index.js';
import { backupBeforeMigration, backupDatabases, listBackups } from '../../src/host/backup.js';
import { buildDiagnosis, isMsixRedirected, LOW_DISK_BYTES } from '../../src/host/diagnose.js';
import { SCHEMA_V1 } from '../../src/store/index.js';
import { loadChatNotes, findChatNote } from '../../src/config/index.js';

const master = Buffer.alloc(32, 7);
let dir: string;
let paths: DataPaths;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-ops-'));
  paths = resolveUserPaths(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeStore(version: number): void {
  const db = openEncryptedDb(paths.storeDb, deriveDbKey(master, 'store'));
  db.exec(SCHEMA_V1);
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(version));
  db.close();
  const auth = openEncryptedDb(paths.authDb, deriveDbKey(master, 'auth'));
  auth.exec('CREATE TABLE IF NOT EXISTS t(x)');
  auth.close();
}

describe('backups', () => {
  it('backs up encrypted copies before an upgrade, records last_backup_at, and not when current', () => {
    makeStore(2);
    expect(backupBeforeMigration(dir, master, { toVersion: 2 })).toBeNull();
    const r = backupBeforeMigration(dir, master, { toVersion: 3, now: () => Date.UTC(2026, 9, 22, 10, 0, 0) });
    expect(r).not.toBeNull();
    expect(path.basename(r?.dir ?? '')).toBe('2026-10-22T10-00-00-000Z-pre-v3');
    expect(r?.files).toEqual(['store.db', 'auth.db']);
    // the copy opens only with the same key and is still at v2
    const copy = openEncryptedDb(path.join(r?.dir ?? '', 'store.db'), deriveDbKey(master, 'store'), { create: false });
    expect((copy.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe('2');
    copy.close();
    expect(() => openEncryptedDb(path.join(r?.dir ?? '', 'store.db'), deriveDbKey(Buffer.alloc(32, 9), 'store'), { create: false })).toThrow();
    const live = openEncryptedDb(paths.storeDb, deriveDbKey(master, 'store'), { create: false });
    expect((live.prepare("SELECT value FROM meta WHERE key='last_backup_at'").get() as { value: string }).value).toBe(String(Math.floor(Date.UTC(2026, 9, 22, 10) / 1000)));
    live.close();
  });

  it('keeps only the newest 3', () => {
    makeStore(2);
    for (let i = 0; i < 5; i++) backupDatabases(dir, master, { label: 'pre-v3', now: () => Date.UTC(2026, 0, 1 + i) });
    const names = listBackups(dir).map((b) => b.name);
    expect(names).toHaveLength(3);
    expect(names[0]).toContain('2026-01-03');
    expect(names[2]).toContain('2026-01-05');
  });
});

describe('diagnose', () => {
  const base = { version: '1', now: () => 1_800_000_000_000, keyPresent: true, linkStatus: 'linked', collector: 'live' as const };
  it('warns when the data folder is MSIX-redirected', () => {
    expect(isMsixRedirected('C:\\Users\\a\\AppData\\Local\\Packages\\Claude_abc\\LocalCache\\Local\\wa-bridge')).toBe(true);
    expect(isMsixRedirected('C:\\Users\\a\\.wa-bridge')).toBe(false);
    const msixPaths = { ...paths, dataDir: 'C:\\Users\\a\\AppData\\Local\\Packages\\Claude_abc\\LocalCache\\wa-bridge' };
    const d = buildDiagnosis({ ...base, paths: msixPaths, meta: () => null, freeBytes: () => 1e12 });
    const c = d.checks.find((x) => x.name === 'data_dir');
    expect(c?.ok).toBe(false);
    expect(c?.fix).toBeTruthy();
  });

  it('warns on low disk, reads health meta defensively and never prints secrets', () => {
    const meta: Record<string, string> = { schema_version: '2', health_reconnects_24h: '30', health_last_reason: 'connection_lost', health_last_frame_at: '', last_live_at: '1799999000' };
    const d = buildDiagnosis({ ...base, paths, meta: (k) => meta[k] ?? null, freeBytes: () => LOW_DISK_BYTES - 1, env: { HTTPS_PROXY: 'http://user:pass@proxy.local:8080' } });
    expect(d.checks.find((x) => x.name === 'disk')?.ok).toBe(false);
    expect(d.checks.find((x) => x.name === 'connection')?.ok).toBe(false);
    expect(d.checks.find((x) => x.name === 'proxy')?.detail).toContain('proxy.local:8080');
    const text = JSON.stringify(d);
    expect(text).not.toContain('pass');
    expect(d.checks.every((c) => c.detail.length > 0)).toBe(true);
  });

  it('works with no store and no health data', () => {
    const d = buildDiagnosis({ ...base, paths, meta: null, linkStatus: null, collector: null, keyPresent: false, freeBytes: () => null });
    expect(d.checks.find((x) => x.name === 'schema')?.ok).toBe(false);
    expect(d.checks.find((x) => x.name === 'keychain')?.ok).toBe(false);
  });
});

describe('chat notes', () => {
  it('loads the chats: section, matches by id or name case-insensitively, warns on unknown keys', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(paths.departments, [
      'departments:', '  - name: ERP', '    keywords: [erp]',
      'chats:',
      '  - chat: "ERP Support"', '    department: ERP', '    note: "Supplier invoices"',
      '  - chat: "123@g.us"', '    note: "Ali = vendor PM. Kal tak matlab aaj hi."', '    colour: red',
      '  - chat: "empty one"',
    ].join('\n'));
    const warnings: string[] = [];
    const notes = loadChatNotes(paths, warnings);
    expect(notes).toEqual([
      { match: 'ERP Support', department: 'ERP', note: 'Supplier invoices' },
      { match: '123@g.us', department: null, note: 'Ali = vendor PM. Kal tak matlab aaj hi.' },
    ]);
    expect(warnings.some((w) => w.includes('colour'))).toBe(true);
    expect(warnings.some((w) => w.includes('empty one'))).toBe(true);
    expect(findChatNote(notes, { id: 'x@g.us', name: 'erp support' })?.department).toBe('ERP');
    expect(findChatNote(notes, { id: '123@G.US', name: null })?.note).toContain('vendor');
    expect(findChatNote(notes, { id: 'z', name: 'Other' })).toBeNull();
  });

  it('the shipped template parses with the five departments and no active chats', async () => {
    const { writeDefaultConfigs, loadDepartments } = await import('../../src/config/index.js');
    writeDefaultConfigs(paths);
    expect(loadDepartments(paths).map((d) => d.name)).toEqual(['ERP', 'IT', 'Finance', 'Sales', 'Ops']);
    expect(loadChatNotes(paths)).toEqual([]);
  });
});
