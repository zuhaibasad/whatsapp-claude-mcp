import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyringBackend } from '../../src/core/contracts.js';
import { defaultDataDir, readLocation, resolveUserPaths, writeLocation } from '../../src/core/paths.js';
import { acquireLock, readLock } from '../../src/daemon/lock.js';
import { createMasterKeyStore, deriveDbKey, keychainAccountId, openEncryptedDb } from '../../src/crypto/index.js';
import type { Dialogs } from '../../src/host/dialog.js';
import { initDataFiles } from '../../src/host/init.js';
import { scanLeftovers } from '../../src/host/leftovers.js';
import { preflight } from '../../src/host/preflight.js';
import { SqliteStore } from '../../src/store/index.js';

const map = new Map<string, string>();
const keyring: KeyringBackend = {
  getPassword: (s, a) => map.get(`${s}/${a}`) ?? null,
  setPassword: (s, a, p) => void map.set(`${s}/${a}`, p),
  deletePassword: (s, a) => map.delete(`${s}/${a}`),
};

let home: string;
let env: NodeJS.ProcessEnv;
const platform = process.platform;

function dialogs(answers: { confirm?: (boolean | null)[]; folder?: (string | null)[] }): Dialogs & { asked: string[] } {
  const asked: string[] = [];
  const c = [...(answers.confirm ?? [])];
  const f = [...(answers.folder ?? [])];
  return {
    asked,
    confirm: async (title) => { asked.push(title); return c.length ? (c.shift() as boolean | null) : false; },
    pickFolder: async (title) => { asked.push(title); return f.length ? (f.shift() as string | null) : ''; },
  };
}

/** A data folder holding an encrypted store, as an earlier install would leave it. */
function seed(dir: string, withKey: boolean): void {
  fs.mkdirSync(dir, { recursive: true });
  const keys = createMasterKeyStore(dir, keyring);
  const master = keys.create();
  const db = openEncryptedDb(path.join(dir, 'store.db'), deriveDbKey(master, 'store'));
  new SqliteStore(db).migrate();
  db.close();
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'x');
  if (!withKey) keyring.deletePassword('chatai', keychainAccountId(dir));
}

beforeEach(() => {
  map.clear();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatai-pre-'));
  env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'Local') };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('data folder pointer', () => {
  it('defaults to the anchor, then follows the chosen folder, CHATAI_HOME wins', () => {
    const anchor = defaultDataDir(env, platform);
    expect(anchor.startsWith(home)).toBe(true);
    const custom = path.join(home, 'D', 'chatai');
    writeLocation({ dataDir: custom }, env, platform);
    expect(defaultDataDir(env, platform)).toBe(custom);
    expect(defaultDataDir({ ...env, CHATAI_HOME: path.join(home, 'x') }, platform)).toBe(path.join(home, 'x'));
    expect(readLocation(env, platform).dataDir).toBe(custom);
  });
  it('ignores a corrupt or relative pointer', () => {
    const anchor = defaultDataDir(env, platform);
    fs.mkdirSync(anchor, { recursive: true });
    fs.writeFileSync(path.join(anchor, 'location.json'), '{"dataDir":"relative/x"}');
    expect(defaultDataDir(env, platform)).toBe(anchor);
    fs.writeFileSync(path.join(anchor, 'location.json'), 'not json');
    expect(defaultDataDir(env, platform)).toBe(anchor);
  });
});

describe('leftovers', () => {
  it('flags a store whose key is gone, and offers to delete it', async () => {
    const paths = resolveUserPaths(defaultDataDir(env, platform));
    seed(paths.dataDir, false);
    const items = scanLeftovers(paths, { keyring, env, platform });
    expect(items.map((i) => i.kind)).toEqual(['unreadable']);

    const d = dialogs({ confirm: [true, true], folder: [] });
    expect(await preflight({ paths, keyring, dialogs: d, env, platform })).toBeNull();
    expect(fs.existsSync(paths.storeDb)).toBe(false);
    expect(d.asked[0]).toMatch(/old data found/);
    expect(scanLeftovers(paths, { keyring, env, platform })).toEqual([]);
  });

  it('keeps everything and blocks setup when the user says keep to unreadable data', async () => {
    const paths = resolveUserPaths(defaultDataDir(env, platform));
    seed(paths.dataDir, false);
    const msg = await preflight({ paths, keyring, dialogs: dialogs({ confirm: [false] }), env, platform });
    expect(msg).toMatch(/cannot continue/);
    expect(fs.existsSync(paths.storeDb)).toBe(true);
  });

  it('does not touch a healthy install and records its folder', async () => {
    const paths = resolveUserPaths(defaultDataDir(env, platform));
    seed(paths.dataDir, true);
    const d = dialogs({});
    expect(await preflight({ paths, keyring, dialogs: d, env, platform })).toBeNull();
    expect(d.asked).toEqual([]);
    expect(fs.existsSync(paths.storeDb)).toBe(true);
    expect(readLocation(env, platform).dataDir).toBe(paths.dataDir);
  });

  it('remembers "keep" for old folders and does not ask again', async () => {
    const paths = resolveUserPaths(path.join(home, 'new', 'chatai'));
    writeLocation({ dataDir: paths.dataDir }, env, platform);
    const old = path.join(home, 'Local', 'wa-bridge');
    seed(old, true);
    const first = dialogs({ confirm: [false] });
    expect(await preflight({ paths, keyring, dialogs: first, env, platform })).toBeNull();
    expect(first.asked.length).toBe(1);
    expect(fs.existsSync(path.join(old, 'store.db'))).toBe(true);
    const second = dialogs({});
    await preflight({ paths, keyring, dialogs: second, env, platform });
    expect(second.asked).toEqual([]);
  });

  it('deletes an old folder with its keychain key when confirmed', async () => {
    const paths = resolveUserPaths(path.join(home, 'new', 'chatai'));
    writeLocation({ dataDir: paths.dataDir }, env, platform);
    const old = path.join(home, '.wa-bridge');
    seed(old, true);
    expect(await preflight({ paths, keyring, dialogs: dialogs({ confirm: [true] }), env, platform })).toBeNull();
    expect(fs.existsSync(path.join(old, 'store.db'))).toBe(false);
    expect(keyring.getPassword('chatai', keychainAccountId(old))).toBeNull();
  });
});

describe('data folder question', () => {
  it('asks once on a fresh install; "use this" is remembered', async () => {
    const paths = resolveUserPaths(defaultDataDir(env, platform));
    const d = dialogs({ confirm: [true] });
    expect(await preflight({ paths, keyring, dialogs: d, env, platform })).toBeNull();
    expect(d.asked[0]).toMatch(/where to store/);
    const again = dialogs({});
    await preflight({ paths, keyring, dialogs: again, env, platform });
    expect(again.asked).toEqual([]);
  });

  it('a chosen folder gets a chatai subfolder and needs a restart', async () => {
    const paths = resolveUserPaths(defaultDataDir(env, platform));
    const picked = path.join(home, 'DDrive');
    const msg = await preflight({ paths, keyring, dialogs: dialogs({ confirm: [false], folder: [picked] }), env, platform });
    expect(msg).toMatch(/Quit Claude/);
    expect(readLocation(env, platform).dataDir).toBe(path.join(picked, 'chatai'));
    expect(defaultDataDir(env, platform)).toBe(path.join(picked, 'chatai'));
    // still running on the old paths: keeps asking for the restart, without more dialogs
    const d = dialogs({});
    expect(await preflight({ paths, keyring, dialogs: d, env, platform })).toMatch(/Quit Claude/);
    expect(d.asked).toEqual([]);
  });

  it('cancelling the folder picker sets nothing up', async () => {
    const paths = resolveUserPaths(defaultDataDir(env, platform));
    const msg = await preflight({ paths, keyring, dialogs: dialogs({ confirm: [false], folder: [''] }), env, platform });
    expect(msg).toMatch(/No folder was chosen/);
    expect(readLocation(env, platform).dataDir).toBeUndefined();
  });

  it('falls back to the default when dialogs are unavailable, and skips with CHATAI_HOME', async () => {
    const paths = resolveUserPaths(defaultDataDir(env, platform));
    expect(await preflight({ paths, keyring, dialogs: dialogs({ confirm: [null] }), env, platform })).toBeNull();
    const d = dialogs({});
    expect(await preflight({ paths, keyring, dialogs: d, env: { ...env, CHATAI_HOME: paths.dataDir }, platform })).toBeNull();
    expect(d.asked).toEqual([]);
  });
});

describe('initDataFiles guard', () => {
  it('refuses to put a new key over an old database', async () => {
    const paths = resolveUserPaths(path.join(home, 'g', 'chatai'));
    seed(paths.dataDir, false);
    await expect(initDataFiles(paths, createMasterKeyStore(paths.dataDir, keyring))).rejects.toThrow(/encryption key is gone/);
  });
});

describe('stale lock from before a reboot', () => {
  it('is taken over even if its pid is alive (pid reuse)', () => {
    const file = path.join(home, 'daemon.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() - os.uptime() * 1000 - 3_600_000 }));
    expect(readLock(file)?.alive).toBe(false);
    const lock = acquireLock(file);
    lock.release();
  });
  it('a fresh lock of a live pid still blocks', () => {
    const file = path.join(home, 'daemon.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    expect(() => acquireLock(file)).toThrow(/already running/);
  });
});
