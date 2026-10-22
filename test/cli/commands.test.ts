import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../src/core/paths.js';
import { initCommand } from '../../src/cli/commands/init.js';
import { linkCommand } from '../../src/cli/commands/link.js';
import { daemonStartCommand } from '../../src/cli/commands/daemon.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { chatsCommand, newCommand, purgeCommand, searchCommand } from '../../src/cli/commands/read.js';
import { unlinkCommand } from '../../src/cli/commands/unlink.js';
import { CliError } from '../../src/cli/io.js';
import { fakeClient, fakeDeps, fakeIo, msg, seed, tmpProject } from './helpers.js';

let proj: ReturnType<typeof tmpProject>;
let project: string;
beforeEach(() => { proj = tmpProject(); project = proj.dir; });
afterEach(() => proj.cleanup());

async function doInit(deps = fakeDeps()) {
  await initCommand({ project }, fakeIo(['I accept']), deps);
  return deps;
}

describe('init', () => {
  it('refuses without the exact phrase', async () => {
    const deps = fakeDeps();
    await expect(initCommand({ project }, fakeIo(['i accept']), deps)).rejects.toMatchObject({ code: 1 });
    expect(fs.existsSync(resolvePaths(project).dataDir)).toBe(false);
    expect(deps.keys.size).toBe(0);
  });
  it('creates everything and is idempotent; .gitignore appended once', async () => {
    fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules');
    const deps = await doInit();
    const p = resolvePaths(project);
    for (const f of [p.storeDb, p.authDb, p.config, p.departments, p.priorities]) expect(fs.existsSync(f)).toBe(true);
    const key = deps.keyStore(project).get()?.toString('hex');
    await initCommand({ project }, fakeIo([]), deps); // no prompt needed
    expect(deps.keyStore(project).get()?.toString('hex')).toBe(key);
    const gi = fs.readFileSync(path.join(project, '.gitignore'), 'utf8');
    expect(gi).toBe('node_modules\n.chatai/\n');
  });
  it('--accept without env is refused; with env works', async () => {
    const deps = fakeDeps();
    await expect(initCommand({ project, accept: true, env: {} }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
    await expect(initCommand({ project, accept: true, env: { CHATAI_ACCEPT_RISK: 'yes' } }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
    const io = fakeIo();
    expect(await initCommand({ project, accept: true, env: { CHATAI_ACCEPT_RISK: 'I accept' } }, io, deps)).toBe(0);
    expect(io.text()).toContain('Terms of Service');
  });
});

describe('status', () => {
  it('uninitialised gives exit 2 without touching the keychain', async () => {
    const deps = fakeDeps({ keyStore: () => { throw new Error('keychain touched'); } });
    const io = fakeIo();
    expect(await statusCommand({ project }, io, deps)).toBe(2);
    expect(io.text()).toContain('Not initialised');
  });
  it('initialised but unlinked warns', async () => {
    const deps = await doInit();
    const io = fakeIo();
    expect(await statusCommand({ project }, io, deps)).toBe(0);
    expect(io.text()).toContain('not running'.slice(0, 3));
    expect(io.text()).toContain('No account linked');
    const j = fakeIo();
    await statusCommand({ project, json: true }, j, deps);
    expect(JSON.parse(j.text()).initialised).toBe(true);
  });
});

describe('read commands', () => {
  const now = 1_800_000_000;
  it('chats, new, search print refs; purge removes old', async () => {
    const deps = await doInit(fakeDeps({ now: () => now * 1000 }));
    seed(project, deps, [
      msg({ id: 'M1', chatId: '1203@g.us', ts: now - 3600, text: 'budget approval needed' }),
      msg({ id: 'M2', chatId: '1203@g.us', ts: now - 40 * 86400, text: 'ancient budget note' }),
    ]);
    const c = fakeIo();
    await chatsCommand({ project }, c, deps);
    expect(c.text()).toContain('1203@g.us');

    const n = fakeIo();
    await newCommand({ project, since: '1d' }, n, deps);
    expect(n.text()).toContain('[ref 1203@g.us/M1]');
    expect(n.text()).not.toContain('M2');

    const s = fakeIo();
    await searchCommand('budget', { project }, s, deps);
    expect(s.text()).toContain('[ref 1203@g.us/M1]');
    expect(s.text()).toContain('[ref 1203@g.us/M2]');

    const miss = fakeIo();
    await expect(searchCommand('budget', { project, chat: 'nope' }, miss, deps)).rejects.toBeInstanceOf(CliError);

    await expect(purgeCommand({ project }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
    await expect(purgeCommand({ project, olderThan: 'abc' }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
    const p = fakeIo();
    await purgeCommand({ project, olderThan: '30d' }, p, deps);
    expect(p.text()).toContain('Purged 1 message ');
    const s2 = fakeIo();
    await searchCommand('budget', { project }, s2, deps);
    expect(s2.text()).not.toContain('M2');
  });
  it('read commands exit 2 when not initialised', async () => {
    await expect(newCommand({ project }, fakeIo(), fakeDeps())).rejects.toMatchObject({ code: 2 });
  });
});

describe('link', () => {
  it('prints QR, writes png, cleans up, reports the number', async () => {
    const deps = await doInit();
    const p = resolvePaths(project);
    let sawPng = false;
    deps.linkAccount = async (o) => {
      await o.onQr('abc');
      sawPng = fs.existsSync(p.qrPng);
      return { id: '92300@s.whatsapp.net', pushName: 'Z' };
    };
    const io = fakeIo();
    expect(await linkCommand({ project }, io, deps)).toBe(0);
    expect(sawPng).toBe(true);
    expect(fs.existsSync(p.qrPng)).toBe(false);
    expect(io.text()).toContain('QR[abc]');
    expect(io.text()).toContain('92300@s.whatsapp.net');
    expect(io.text()).toContain('daemon start');
  });
  it('requires init', async () => {
    await expect(linkCommand({ project }, fakeIo(), fakeDeps())).rejects.toMatchObject({ code: 2 });
  });
});

describe('daemon start', () => {
  it('foreground runs and stops; detach spawns', async () => {
    const deps = await doInit();
    const calls: string[] = [];
    deps.runDaemon = async () => ({ stop: async () => void calls.push('stop') });
    expect(await daemonStartCommand({ project }, fakeIo(), deps)).toBe(0);
    expect(calls).toEqual(['stop']);
    const io = fakeIo();
    await daemonStartCommand({ project, detach: true }, io, deps);
    expect(io.text()).toContain('4242');
  });
});

describe('unlink', () => {
  async function linkedSetup() {
    const deps = await doInit();
    // plant creds so hasCreds() is true
    const { openAuthDb } = await import('../../src/cli/open.js');
    const db = openAuthDb(resolvePaths(project), deps, { create: false });
    db.prepare('INSERT INTO auth_kv(key,value) VALUES (?,?)').run('creds', JSON.stringify({ me: { id: '1:2@s.whatsapp.net' } }));
    db.close();
    return deps;
  }

  it('requires the phrase', async () => {
    const deps = await doInit();
    await expect(unlinkCommand({ project }, fakeIo(['yes']), deps)).rejects.toMatchObject({ code: 1 });
    expect(fs.existsSync(resolvePaths(project).authDb)).toBe(true);
  });
  it('logs out once and wipes everything', async () => {
    const deps = await linkedSetup();
    const client = fakeClient();
    deps.createClient = () => client;
    const io = fakeIo(['unlink']);
    expect(await unlinkCommand({ project }, io, deps)).toBe(0);
    expect(client.calls.filter((c) => c === 'unlink')).toHaveLength(1);
    expect(client.calls[0]).toBe('connect');
    const p = resolvePaths(project);
    expect(fs.existsSync(p.dataDir)).toBe(false);
    expect(deps.keyStore(project).get()).toBeNull();
    expect(io.text()).toContain('WhatsApp device removed:  yes');
  });
  it('--keep-data keeps the store and key', async () => {
    const deps = await linkedSetup();
    const client = fakeClient();
    deps.createClient = () => client;
    await unlinkCommand({ project, keepData: true }, fakeIo(['unlink']), deps);
    const p = resolvePaths(project);
    expect(fs.existsSync(p.authDb)).toBe(false);
    expect(fs.existsSync(p.storeDb)).toBe(true);
    expect(fs.existsSync(p.config)).toBe(true);
    expect(deps.keyStore(project).get()).not.toBeNull();
  });
  it('still wipes locally when WhatsApp never opens', async () => {
    const deps = await linkedSetup();
    const client = fakeClient({ opens: false });
    deps.createClient = () => client;
    const io = fakeIo(['unlink']);
    expect(await unlinkCommand({ project }, io, deps)).toBe(0);
    expect(client.calls).not.toContain('unlink');
    expect(fs.existsSync(resolvePaths(project).authDb)).toBe(false);
    expect(io.text()).toContain('Remove the device manually');
  });
});
