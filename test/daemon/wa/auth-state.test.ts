import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto } from 'baileys';
import { useDbAuthState } from '../../../src/daemon/wa/auth-state.js';

describe('useDbAuthState', () => {
  it('creates the table and fresh creds', async () => {
    const db = new Database(':memory:');
    const a = await useDbAuthState(db);
    expect(a.state.creds.noiseKey).toBeDefined();
    expect(a.hasCreds()).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='auth_kv'").get()).toBeTruthy();
  });

  it('creds survive reopen (Buffers revived)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-auth-'));
    const file = join(dir, 'a.db');
    try {
      let db = new Database(file);
      const a = await useDbAuthState(db);
      a.state.creds.me = { id: '1:2@s.whatsapp.net', name: 'Me' };
      await a.saveCreds();
      const noise = Buffer.from(a.state.creds.noiseKey.public);
      db.close();

      db = new Database(file);
      const b = await useDbAuthState(db);
      expect(b.hasCreds()).toBe(true);
      expect(b.state.creds.me?.id).toBe('1:2@s.whatsapp.net');
      expect(Buffer.from(b.state.creds.noiseKey.public).equals(noise)).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keys set / get / delete', async () => {
    const db = new Database(':memory:');
    const a = await useDbAuthState(db);
    await a.state.keys.set({
      session: { 'a.1': new Uint8Array([1, 2, 3]), 'b.1': new Uint8Array([9]) },
      'sender-key-memory': { g1: { x: true } },
    });
    const got = await a.state.keys.get('session', ['a.1', 'b.1', 'missing']);
    expect(Buffer.from(got['a.1']!).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(got['missing']).toBeNull();
    await a.state.keys.set({ session: { 'a.1': null } });
    expect((await a.state.keys.get('session', ['a.1']))['a.1']).toBeNull();
    expect((await a.state.keys.get('session', ['b.1']))['b.1']).toBeTruthy();
  });

  it('revives app-state-sync-key as a protobuf message', async () => {
    const db = new Database(':memory:');
    const a = await useDbAuthState(db);
    await a.state.keys.set({ 'app-state-sync-key': { K1: proto.Message.AppStateSyncKeyData.fromObject({ keyData: Buffer.from('abc') }) } });
    const got = (await a.state.keys.get('app-state-sync-key', ['K1']))['K1']!;
    expect(got).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(Buffer.from(got.keyData!).toString()).toBe('abc');
  });

  it('keys.set is one transaction (rolls back on failure)', async () => {
    const db = new Database(':memory:');
    const a = await useDbAuthState(db);
    const bad = { toJSON() { throw new Error('boom'); } };
    await expect(a.state.keys.set({ session: { ok: new Uint8Array([1]), bad: bad as never } })).rejects.toThrow('boom');
    expect((await a.state.keys.get('session', ['ok']))['ok']).toBeNull();
  });

  it('clear() wipes everything', async () => {
    const db = new Database(':memory:');
    const a = await useDbAuthState(db);
    a.state.creds.me = { id: 'x@s.whatsapp.net' };
    await a.saveCreds();
    await a.state.keys.set({ session: { s: new Uint8Array([1]) } });
    a.clear();
    expect((db.prepare('SELECT COUNT(*) AS n FROM auth_kv').get() as { n: number }).n).toBe(0);
    expect(a.hasCreds()).toBe(false);
    expect(a.state.creds.me).toBeUndefined();
  });
});
