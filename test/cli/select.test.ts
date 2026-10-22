import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/index.js';
import { initCommand } from '../../src/cli/commands/init.js';
import { resolveChat, selectCommand } from '../../src/cli/commands/select.js';
import { CliError } from '../../src/cli/io.js';
import { openStore } from '../../src/cli/open.js';
import { buildChatRows, currentSelection } from '../../src/config/selection.js';
import { loadConfig } from '../../src/config/load.js';
import { resolvePaths } from '../../src/core/paths.js';
import { fakeDeps, fakeIo, tmpProject } from './helpers.js';

let proj: ReturnType<typeof tmpProject>;
let project: string;
let deps: ReturnType<typeof fakeDeps>;
beforeEach(async () => {
  proj = tmpProject();
  project = proj.dir;
  deps = fakeDeps();
  await initCommand({ project }, fakeIo(['I accept']), deps);
  const { store, close } = openStore(resolvePaths(project), deps, { write: true });
  store.upsertChat({ id: '1@g.us', type: 'group', name: 'Hisab Kitab', included: true, lastMessageAt: 300 });
  store.upsertChat({ id: '2@g.us', type: 'group', name: 'LUMS Alumni', included: true, lastMessageAt: 200 });
  store.upsertChat({ id: '3@s.whatsapp.net', type: 'direct', name: 'Ali Raza', included: false, lastMessageAt: 100 });
  store.upsertChat({ id: '4@s.whatsapp.net', type: 'direct', name: 'Ali Khan', included: false });
  store.upsertChat({ id: '5@s.whatsapp.net', type: 'direct', name: 'امی جان 🌸', included: false, lastMessageAt: 400 });
  close();
});
afterEach(() => proj.cleanup());

const included = (): string[] => {
  const { config } = loadConfig(resolvePaths(project));
  const { store, close } = openStore(resolvePaths(project), deps, { write: false });
  try {
    const all = store.listChats({});
    return [...currentSelection(config, all)].sort();
  } finally {
    close();
  }
};

describe('buildChatRows', () => {
  it('sorts newest first with nulls last and marks the current selection', () => {
    const { store, close } = openStore(resolvePaths(project), deps, { write: false });
    const rows = buildChatRows(store, loadConfig(resolvePaths(project)).config);
    close();
    expect(rows.map((r) => r.id)).toEqual(['5@s.whatsapp.net', '1@g.us', '2@g.us', '3@s.whatsapp.net', '4@s.whatsapp.net']);
    expect(rows.map((r) => r.preselected)).toEqual([false, true, true, false, false]);
  });
});

describe('resolveChat', () => {
  const all = [
    { id: '1@g.us', name: 'Hisab Kitab', type: 'group' as const },
    { id: '3@s.whatsapp.net', name: 'Ali Raza', type: 'direct' as const },
    { id: '4@s.whatsapp.net', name: 'Ali Khan', type: 'direct' as const },
  ];
  it('id, exact name, unique substring', () => {
    expect(resolveChat('1@g.us', all).id).toBe('1@g.us');
    expect(resolveChat('ali raza', all).id).toBe('3@s.whatsapp.net');
    expect(resolveChat('kitab', all).id).toBe('1@g.us');
  });
  it('ambiguous lists candidates and exits 1; unknown errors', () => {
    expect.assertions(4);
    try {
      resolveChat('ali', all);
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(1);
      expect((e as CliError).message).toContain('Ali Khan');
    }
    expect(() => resolveChat('zzz', all)).toThrow(/No chat matches/);
  });
});

describe('chats select / include / exclude', () => {
  it('no flags only reports', async () => {
    const io = fakeIo();
    expect(await selectCommand({ project }, io, deps)).toBe(0);
    expect(io.text()).toContain('2/2 groups, 0/3 direct');
    expect(fs.readFileSync(resolvePaths(project).config, 'utf8')).not.toContain('"3@s');
  });

  it('include turns a DM on and writes an id with a name comment', async () => {
    const io = fakeIo();
    await selectCommand({ project, include: ['ali raza'] }, io, deps);
    expect(included()).toEqual(['1@g.us', '2@g.us', '3@s.whatsapp.net']);
    expect(fs.readFileSync(resolvePaths(project).config, 'utf8')).toContain('"3@s.whatsapp.net" # Ali Raza');
    expect(io.text()).toContain('Turned on (1)');
    expect(io.text()).toContain('only captures new messages');
  });

  it('exclude turns a group off; Urdu/emoji names work', async () => {
    await selectCommand({ project, exclude: ['lums'], include: ['امی'] }, fakeIo(), deps);
    expect(included()).toEqual(['1@g.us', '5@s.whatsapp.net']);
  });

  it('--none then --groups all; --all', async () => {
    await selectCommand({ project, none: true }, fakeIo(), deps);
    expect(included()).toEqual([]);
    await selectCommand({ project, groups: 'all' }, fakeIo(), deps);
    expect(included()).toEqual(['1@g.us', '2@g.us']);
    await selectCommand({ project, all: true }, fakeIo(), deps);
    expect(included()).toHaveLength(5);
    await selectCommand({ project, direct: 'none' }, fakeIo(), deps);
    expect(included()).toEqual(['1@g.us', '2@g.us']);
  });

  it('rejects bad flags and ambiguous names without changing config', async () => {
    const before = fs.readFileSync(resolvePaths(project).config, 'utf8');
    await expect(selectCommand({ project, all: true, none: true }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
    await expect(selectCommand({ project, groups: 'some' }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
    await expect(selectCommand({ project, include: ['ali'] }, fakeIo(), deps)).rejects.toMatchObject({ code: 1 });
    expect(fs.readFileSync(resolvePaths(project).config, 'utf8')).toBe(before);
  });

  it('works through the commander program, and bare `chats` still lists', async () => {
    let code = -1;
    const io = fakeIo();
    const fresh = () => buildProgram(io, deps, (c) => { code = c; });
    await fresh().parseAsync(['node', 'wa-bridge', '--project', project, 'chats', 'include', 'Ali Raza']);
    expect(code).toBe(0);
    expect(included()).toContain('3@s.whatsapp.net');
    await fresh().parseAsync(['node', 'wa-bridge', '--project', project, 'chats', 'select', '--set-groups', 'none']);
    expect(included()).toEqual(['3@s.whatsapp.net']);
    await fresh().parseAsync(['node', 'wa-bridge', '--project', project, 'chats', 'select', '--all']);
    expect(included()).toHaveLength(5);
    const io2 = fakeIo();
    const prog2 = buildProgram(io2, deps, (c) => { code = c; });
    await prog2.parseAsync(['node', 'wa-bridge', '--project', project, 'chats', '--all']);
    expect(io2.text()).toContain('Hisab Kitab');
  });
});
