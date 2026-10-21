import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, MasterKeyStore, WaClient } from '../../src/core/contracts.js';
import { createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { deriveDbKey, openEncryptedDb } from '../../src/crypto/index.js';
import { AlreadyLinkedError, linkAccount } from '../../src/daemon/link.js';
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
    const p = linkAccount({ projectRoot: dir, onQr: (q) => void qrs.push(q), deps: deps() });
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
});
