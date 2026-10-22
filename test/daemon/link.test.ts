import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, MasterKeyStore, WaClient } from '../../src/core/contracts.js';
import type { ChatRow, RawMessage } from '../../src/core/contracts.js';
import { createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { deriveDbKey, openEncryptedDb } from '../../src/crypto/index.js';
import { AlreadyLinkedError, ExcludedBuffer, linkAccount } from '../../src/daemon/link.js';
import { useDbAuthState } from '../../src/daemon/wa/index.js';
import { SqliteStore } from '../../src/store/index.js';

const MASTER = Buffer.alloc(32, 7);
const keyStore = (): MasterKeyStore => ({ get: () => MASTER, create: () => MASTER, delete: () => true });
const OPEN: ConnectionState = { state: 'open', me: { id: '999@s.whatsapp.net', lid: '888@lid', pushName: 'Me' } };

class FakeClient implements WaClient {
  private readonly ee = new EventEmitter();
  connect = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  unlink = vi.fn(async () => undefined);
  on(event: string, listener: (...a: never[]) => void): void {
    this.ee.on(event, listener as (...a: unknown[]) => void);
  }
  emit(event: string, payload: unknown): void {
    this.ee.emit(event, payload);
  }
  conn(s: ConnectionState): void {
    this.emit('connection', s);
  }
}

let dir: string;
let client: FakeClient;
const logger = createLogger({ level: 'silent' });
const deps = () => ({ keyStore, waClientFactory: () => client, logger });
const qrPng = (): string => resolvePaths(dir).qrPng;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const FAST = { minMs: 0, quietMs: 20, maxMs: 2000 };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-link-'));
  fs.mkdirSync(resolvePaths(dir).dataDir, { recursive: true });
  client = new FakeClient();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('linkAccount', () => {
  it('calls onQr, survives restart_required, resolves on open and records the account', async () => {
    fs.writeFileSync(qrPng(), 'png');
    const qrs: string[] = [];
    const status: string[] = [];
    const p = linkAccount({ projectRoot: dir, onQr: (q) => void qrs.push(q), onStatus: (m) => void status.push(m), settle: FAST, deps: deps() });
    await tick();
    await tick();
    client.conn({ state: 'qr', qr: 'QR1' });
    client.conn({ state: 'qr', qr: 'QR2' });
    await tick();
    expect(qrs).toEqual(['QR1', 'QR2']);
    client.conn({ state: 'close', reason: 'restart_required', retry: true });
    expect(client.connect).toHaveBeenCalledTimes(2);
    client.conn(OPEN);
    await expect(p).resolves.toEqual({ id: '999@s.whatsapp.net', pushName: 'Me' });
    expect(status.some((m) => /initial sync/.test(m))).toBe(true);
    expect(client.close).toHaveBeenCalled();
    expect(client.unlink).not.toHaveBeenCalled();
    expect(fs.existsSync(qrPng())).toBe(false);
    expect(fs.existsSync(resolvePaths(dir).lockFile)).toBe(false);
    const db = openEncryptedDb(resolvePaths(dir).storeDb, deriveDbKey(MASTER, 'store'));
    expect(new SqliteStore(db).getAccount()).toMatchObject({ id: '999@s.whatsapp.net', linkStatus: 'linked' });
    db.close();
  });

  it('rejects on timeout and deletes qr.png', async () => {
    vi.useFakeTimers();
    fs.writeFileSync(qrPng(), 'png');
    const p = linkAccount({ projectRoot: dir, onQr: () => undefined, timeoutMs: 5000, deps: deps() });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    expect(client.close).toHaveBeenCalled();
    expect(fs.existsSync(qrPng())).toBe(false);
    expect(fs.existsSync(resolvePaths(dir).lockFile)).toBe(false);
  });

  it('rejects on logged_out and deletes qr.png', async () => {
    fs.writeFileSync(qrPng(), 'png');
    const p = linkAccount({ projectRoot: dir, onQr: () => undefined, deps: deps() });
    const assertion = expect(p).rejects.toThrow(/logged out/);
    await tick();
    await tick();
    client.conn({ state: 'close', reason: 'logged_out', retry: false });
    await assertion;
    expect(client.close).toHaveBeenCalled();
    expect(fs.existsSync(qrPng())).toBe(false);
  });

  it('rejects when onQr throws and deletes qr.png', async () => {
    fs.writeFileSync(qrPng(), 'png');
    const p = linkAccount({ projectRoot: dir, onQr: () => { throw new Error('render failed'); }, deps: deps() });
    const assertion = expect(p).rejects.toThrow(/render failed/);
    await tick();
    await tick();
    client.conn({ state: 'qr', qr: 'Q' });
    await assertion;
    expect(fs.existsSync(qrPng())).toBe(false);
  });

  it('refuses when a live lock exists', async () => {
    fs.writeFileSync(resolvePaths(dir).lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fs.writeFileSync(qrPng(), 'png');
    await expect(linkAccount({ projectRoot: dir, onQr: () => undefined, deps: deps() })).rejects.toThrow(/stop the daemon first/);
    expect(client.connect).not.toHaveBeenCalled();
    expect(fs.existsSync(qrPng())).toBe(false);
    expect(fs.existsSync(resolvePaths(dir).lockFile)).toBe(true);
  });

  it('throws AlreadyLinkedError when creds and a linked account exist', async () => {
    const paths = resolvePaths(dir);
    const adb = openEncryptedDb(paths.authDb, deriveDbKey(MASTER, 'auth'));
    await useDbAuthState(adb);
    adb.prepare('INSERT INTO auth_kv(key, value) VALUES (?, ?)').run('creds', JSON.stringify({ me: { id: '999:1@s.whatsapp.net' } }));
    adb.close();
    const sdb = openEncryptedDb(paths.storeDb, deriveDbKey(MASTER, 'store'));
    const s = new SqliteStore(sdb);
    s.migrate();
    s.upsertAccount({ id: '999@s.whatsapp.net', linkStatus: 'linked' });
    sdb.close();
    await expect(linkAccount({ projectRoot: dir, onQr: () => undefined, deps: deps() })).rejects.toBeInstanceOf(AlreadyLinkedError);
    expect(client.connect).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });

  it('stays connected after open and stores the initial sync before closing', async () => {
    const p = linkAccount({ projectRoot: dir, onQr: () => undefined, settle: { minMs: 0, quietMs: 150, maxMs: 5000 }, deps: deps() });
    await tick();
    await tick();
    client.conn(OPEN);
    await tick();
    expect(client.close).not.toHaveBeenCalled(); // not closed right at open
    client.emit('chats', [{ id: '1203@g.us', type: 'group', name: 'Ops' }]);
    client.emit('messages', [{
      id: 'M1', chatId: '1203@g.us', senderId: '111@s.whatsapp.net', senderName: 'Ali', ts: Math.floor(Date.now() / 1000),
      text: 'server down hai, check karo', quotedId: null, quotedSenderId: null, mentions: [], isFromMe: false,
      hasMedia: false, mediaType: null,
    }]);
    await p;
    expect(client.close).toHaveBeenCalled();
    const db = openEncryptedDb(resolvePaths(dir).storeDb, deriveDbKey(MASTER, 'store'));
    const store = new SqliteStore(db);
    expect(store.getMessage('1203@g.us', 'M1')?.text).toBe('server down hai, check karo');
    expect(store.getMeta('last_sync_at')).not.toBeNull();
    db.close();
  });

  it('resolves as linked when the connection drops while settling', async () => {
    const p = linkAccount({ projectRoot: dir, onQr: () => undefined, settle: { minMs: 60000, quietMs: 60000, maxMs: 60000 }, deps: deps() });
    await tick();
    await tick();
    client.conn(OPEN);
    await tick();
    client.conn({ state: 'close', reason: 'connection_lost', retry: true });
    await expect(p).resolves.toMatchObject({ id: '999@s.whatsapp.net' });
  });
});

describe('linkAccount chooseChats', () => {
  const GA = '100@g.us'; // Alpha, group (included by default)
  const GB = '200@g.us'; // Beta, group (included by default)
  const DM = '300@s.whatsapp.net'; // Carol, direct (excluded by default)
  const DM2 = '400@s.whatsapp.net'; // Dave, direct (excluded by default)
  const m = (id: string, chatId: string): RawMessage => ({
    id, chatId, senderId: '111@s.whatsapp.net', senderName: 'X', ts: Math.floor(Date.now() / 1000), text: `text ${id}`,
    quotedId: null, quotedSenderId: null, mentions: [], isFromMe: false, hasMedia: false, mediaType: null,
  });

  async function run(
    choose: ((rows: ChatRow[], peek: () => string[]) => Promise<Set<string> | null>) | undefined,
    extra: { bufferCap?: number } = {},
  ): Promise<{ rows: ChatRow[]; stored: string[]; storedDuring: string[] }> {
    const paths = resolvePaths(dir);
    let rows: ChatRow[] = [];
    const storedIds = (): string[] => {
      const db = openEncryptedDb(paths.storeDb, deriveDbKey(MASTER, 'store'), { readonly: true, create: false });
      try {
        return (db.prepare("SELECT chat_id || '/' || id AS k FROM messages ORDER BY k").all() as { k: string }[]).map((r) => r.k);
      } finally {
        db.close();
      }
    };
    const storedDuring: string[] = [];
    const p = linkAccount({
      projectRoot: dir, onQr: () => undefined, settle: FAST, deps: deps(), ...extra,
      ...(choose ? {
        chooseChats: async (r: ChatRow[]) => {
          rows = r;
          expect(client.close).toHaveBeenCalled(); // the WhatsApp client is closed before the user chooses
          return choose(r, () => storedIds());
        },
      } : {}),
    });
    await tick();
    await tick();
    client.conn(OPEN);
    await tick();
    client.emit('chats', [
      { id: GA, type: 'group', name: 'Alpha' }, { id: GB, type: 'group', name: 'Beta' },
      { id: DM, type: 'direct', name: 'Carol' }, { id: DM2, type: 'direct', name: 'Dave' },
    ]);
    client.emit('messages', [m('a1', GA), m('b1', GB), m('c1', DM), m('c2', DM), m('d1', DM2)]);
    await p;
    return { rows, stored: storedIds(), storedDuring };
  }

  it('does not store excluded-chat messages before the choice; storing a chosen DM restores its buffer', async () => {
    let before: string[] = [];
    const out = await run(async (rows, peek) => {
      before = peek();
      return new Set(rows.filter((r) => r.preselected).map((r) => r.id).concat([DM]));
    });
    expect(before).toEqual([`${GA}/a1`, `${GB}/b1`]);
    expect(out.rows.find((r) => r.id === DM)).toMatchObject({ name: 'Carol', preselected: false, type: 'direct' });
    expect(out.rows.find((r) => r.id === GA)?.preselected).toBe(true);
    expect(out.stored).toEqual([`${GA}/a1`, `${GB}/b1`, `${DM}/c1`, `${DM}/c2`]);
    const cfg = fs.readFileSync(resolvePaths(dir).config, 'utf8');
    expect(cfg).toContain('# Carol');
  });

  it('deletes already stored messages of a deselected group', async () => {
    const out = await run(async () => new Set([GA]));
    expect(out.stored).toEqual([`${GA}/a1`]);
    const db = openEncryptedDb(resolvePaths(dir).storeDb, deriveDbKey(MASTER, 'store'));
    const store = new SqliteStore(db);
    expect(store.getChat(GB)?.included).toBe(false);
    expect(store.searchMessages('text', { limit: 10 }).map((h) => h.message.id)).toEqual(['a1']);
    db.close();
  });

  it('a null choice discards the buffer and keeps the defaults', async () => {
    const out = await run(async () => null);
    expect(out.stored).toEqual([`${GA}/a1`, `${GB}/b1`]);
    expect(fs.existsSync(resolvePaths(dir).config)).toBe(false);
  });

  it('without chooseChats nothing is buffered or written beyond the defaults', async () => {
    const out = await run(undefined);
    expect(out.stored).toEqual([`${GA}/a1`, `${GB}/b1`]);
  });
});

describe('ExcludedBuffer', () => {
  const msg = (id: string, chatId = 'c@s.whatsapp.net'): RawMessage => ({
    id, chatId, senderId: 's', senderName: null, ts: 1, text: id, quotedId: null, quotedSenderId: null,
    mentions: [], isFromMe: false, hasMedia: false, mediaType: null,
  });

  it('drops the oldest messages beyond the cap', () => {
    const b = new ExcludedBuffer(3);
    for (let i = 1; i <= 5; i++) b.add(msg(`m${i}`));
    expect(b.size).toBe(3);
    expect(b.dropped).toBe(2);
    expect([...b.byChat().values()][0]?.map((x) => x.id)).toEqual(['m3', 'm4', 'm5']);
    b.clear();
    expect(b.size).toBe(0);
  });

  it('compacts without losing order', () => {
    const b = new ExcludedBuffer(5);
    for (let i = 0; i < 40_000; i++) b.add(msg(`m${i}`, i % 2 ? 'a@g.us' : 'b@g.us'));
    expect(b.size).toBe(5);
    expect([...b.byChat().values()].flat().map((x) => x.id)).toEqual(['m39995', 'm39997', 'm39999', 'm39996', 'm39998']);
  });
});
