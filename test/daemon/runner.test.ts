import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, MasterKeyStore, WaClient } from '../../src/core/contracts.js';
import { createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { deriveDbKey, openEncryptedDb } from '../../src/crypto/index.js';
import { runDaemon } from '../../src/daemon/runner.js';
import { useDbAuthState } from '../../src/daemon/wa/index.js';
import { SqliteStore } from '../../src/store/index.js';

const MASTER = Buffer.alloc(32, 7);
const keyStore = (): MasterKeyStore => ({ get: () => MASTER, create: () => MASTER, delete: () => true });
const noKeyStore = (): MasterKeyStore => ({ get: () => null, create: () => MASTER, delete: () => false });
const OPEN: ConnectionState = { state: 'open', me: { id: '999@s.whatsapp.net', lid: '888@lid', pushName: 'Me' } };
const lost = (): ConnectionState => ({ state: 'close', reason: 'connection_lost', retry: true });

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
const deps = () => ({ keyStore, waClientFactory: () => client, logger, installSignalHandlers: false });

async function seedAuth(linked: boolean): Promise<void> {
  fs.mkdirSync(resolvePaths(dir).dataDir, { recursive: true });
  const db = openEncryptedDb(resolvePaths(dir).authDb, deriveDbKey(MASTER, 'auth'));
  await useDbAuthState(db);
  if (linked) {
    db.prepare('INSERT INTO auth_kv(key, value) VALUES (?, ?)').run('creds', JSON.stringify({ me: { id: '999:1@s.whatsapp.net' } }));
  }
  db.close();
}

function readStore<T>(fn: (s: SqliteStore) => T): T {
  const db = openEncryptedDb(resolvePaths(dir).storeDb, deriveDbKey(MASTER, 'store'));
  try {
    return fn(new SqliteStore(db));
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-run-'));
  client = new FakeClient();
  await seedAuth(true);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runDaemon', () => {
  it('refuses to start without a key, releasing the lock', async () => {
    await expect(runDaemon({ projectRoot: dir, deps: { ...deps(), keyStore: noKeyStore } })).rejects.toThrow(/wa-bridge init/);
    expect(fs.existsSync(resolvePaths(dir).lockFile)).toBe(false);
  });

  it('refuses to start when not linked', async () => {
    fs.rmSync(resolvePaths(dir).authDb);
    await seedAuth(false);
    await expect(runDaemon({ projectRoot: dir, deps: deps() })).rejects.toThrow(/wa-bridge link/);
    expect(fs.existsSync(resolvePaths(dir).lockFile)).toBe(false);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('connects, records the account on open, and stop() releases the lock without unlinking', async () => {
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(resolvePaths(dir).lockFile)).toBe(true);
    client.conn(OPEN);
    expect(readStore((s) => s.getAccount())).toMatchObject({ id: '999@s.whatsapp.net', lid: '888@lid', linkStatus: 'linked' });
    await d.stop();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.unlink).not.toHaveBeenCalled();
    expect(fs.existsSync(resolvePaths(dir).lockFile)).toBe(false);
    await expect(d.done).resolves.toEqual({ reason: 'stop' });
    await d.stop();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('a second daemon cannot start while the first runs', async () => {
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    await expect(runDaemon({ projectRoot: dir, deps: { ...deps(), waClientFactory: () => new FakeClient() } })).rejects.toThrow(/already running/);
    await d.stop();
  });

  it('reconnects after backoff with a single connect in flight', async () => {
    vi.useFakeTimers();
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    client.conn(OPEN);
    client.conn(lost());
    expect(readStore((s) => s.getAccount()?.linkStatus)).toBe('disconnected');
    client.conn(lost());
    expect(client.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    // Attempt is in flight (no open/close yet): a repeated close event schedules once, then nothing more.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    await d.stop();
  });

  it('gives increasing delays over 5 consecutive failures, and resets after open', async () => {
    vi.useFakeTimers();
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = client.connect.mock.calls.length;
      client.conn(lost());
      let waited = 0;
      while (client.connect.mock.calls.length === before && waited < 700_000) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      delays.push(waited);
    }
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]!);
    client.conn(OPEN);
    const before = client.connect.mock.calls.length;
    client.conn(lost());
    await vi.advanceTimersByTimeAsync(7000);
    expect(client.connect.mock.calls.length).toBe(before + 1);
    await d.stop();
  });

  it('retries after connect() itself rejects, without a tight loop', async () => {
    vi.useFakeTimers();
    client.connect.mockRejectedValueOnce(new Error('boom'));
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    await d.stop();
  });

  it('logged_out stops the daemon without reconnecting', async () => {
    vi.useFakeTimers();
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    client.conn(OPEN);
    client.conn({ state: 'close', reason: 'logged_out', retry: false });
    await expect(d.done).resolves.toEqual({ reason: 'logged_out' });
    await vi.advanceTimersByTimeAsync(700_000);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.unlink).not.toHaveBeenCalled();
    expect(readStore((s) => s.getAccount()?.linkStatus)).toBe('logged_out');
    expect(fs.existsSync(resolvePaths(dir).lockFile)).toBe(false);
  });

  it('restart_required reconnects immediately once, then falls back to backoff', async () => {
    vi.useFakeTimers();
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    const restart: ConnectionState = { state: 'close', reason: 'restart_required', retry: true };
    client.conn(restart);
    expect(client.connect).toHaveBeenCalledTimes(2);
    client.conn(restart);
    expect(client.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7000);
    expect(client.connect).toHaveBeenCalledTimes(3);
    await d.stop();
  });

  it('a QR request while running marks logged_out and stops', async () => {
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    client.conn(OPEN);
    client.conn({ state: 'qr', qr: 'abc' });
    await expect(d.done).resolves.toEqual({ reason: 'qr_requested' });
    expect(readStore((s) => s.getAccount()?.linkStatus)).toBe('logged_out');
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('purges old messages at startup and records last_purge_at', async () => {
    const sdb = openEncryptedDb(resolvePaths(dir).storeDb, deriveDbKey(MASTER, 'store'));
    const s = new SqliteStore(sdb);
    s.migrate();
    s.insertMessage({
      id: 'old', chatId: '1@g.us', senderId: 'a@s.whatsapp.net', senderName: null, ts: 100, text: 'old',
      quotedId: null, quotedSenderId: null, mentions: [], mentionReason: null, isFromMe: false, hasMedia: false, mediaType: null,
    });
    sdb.close();
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    expect(readStore((st) => ({ n: st.counts().messages, p: st.getMeta('last_purge_at'), v: st.getMeta('last_vacuum_at') }))).toMatchObject({ n: 0 });
    expect(readStore((st) => st.getMeta('last_purge_at'))).not.toBeNull();
    await d.stop();
  });

  it('ingests events and records last_sync_at', async () => {
    const d = await runDaemon({ projectRoot: dir, deps: deps() });
    client.conn(OPEN);
    client.emit('messages', [{
      id: 'm1', chatId: '1@g.us', senderId: 'a@s.whatsapp.net', senderName: null, ts: Math.floor(Date.now() / 1000),
      text: 'hi', quotedId: null, quotedSenderId: null, mentions: ['888@lid'], isFromMe: false, hasMedia: false, mediaType: null,
    }]);
    expect(readStore((s) => s.getMessage('1@g.us', 'm1')?.mentionReason)).toBe('at_mention');
    expect(readStore((s) => s.getMeta('last_sync_at'))).not.toBeNull();
    await d.stop();
  });
});
