import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportCommand, itemsCommand, itemStatusCommand } from '../../src/cli/commands/items.js';
import { initCommand } from '../../src/cli/commands/init.js';
import { openStore } from '../../src/cli/open.js';
import { CliError } from '../../src/cli/io.js';
import { resolvePaths } from '../../src/core/paths.js';
import { fakeDeps, fakeIo, msg, seed, tmpProject } from './helpers.js';
import { toCsv, csvCell } from '../../src/export/index.js';

let proj: ReturnType<typeof tmpProject>;
let project: string;
let deps: ReturnType<typeof fakeDeps>;
beforeEach(async () => {
  proj = tmpProject();
  project = proj.dir;
  deps = fakeDeps();
  await initCommand({ project }, fakeIo(['I accept']), deps);
  seed(project, deps, [msg({ id: 'm1', chatId: '1@g.us', ts: 1_700_000_000 })]);
  const { store, close } = openStore(resolvePaths(project), deps, { write: true });
  store.saveItems([
    { chatId: '1@g.us', messageId: 'm1', category: 'request', department: 'Ops', priority: 'high', summary: 'First', requester: null },
    { chatId: '1@g.us', messageId: 'm1', category: 'fyi', department: null, priority: 'low', summary: 'Second', requester: 'Ali' },
  ]);
  close();
});
afterEach(() => proj.cleanup());

describe('items CLI', () => {
  it('lists, filters and outputs json', async () => {
    const io = fakeIo();
    await itemsCommand({ project }, io, deps);
    expect(io.text()).toContain('First');
    expect(io.text()).toContain('Second');
    const j = fakeIo();
    await itemsCommand({ project, priority: 'high', json: true }, j, deps);
    const rows = JSON.parse(j.text());
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('First');
  });
  it('rejects bad flag values', async () => {
    await expect(itemsCommand({ project, status: 'weird' }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
  });
  it('done and dismiss update status; unknown id errors', async () => {
    await itemStatusCommand('1', 'done', { project }, fakeIo(), deps);
    await itemStatusCommand('2', 'dismissed', { project }, fakeIo(), deps);
    const j = fakeIo();
    await itemsCommand({ project, status: 'done', json: true }, j, deps);
    expect(JSON.parse(j.text())).toHaveLength(1);
    await expect(itemStatusCommand('99', 'done', { project }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
    await expect(itemStatusCommand('x', 'done', { project }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
  });
  it('export writes inside the project and refuses outside', async () => {
    const io = fakeIo();
    await exportCommand({ project, format: 'csv' }, io, deps);
    expect(io.text()).toMatch(/Exported 2 items to \.chatai\/exports\/items-/);
    await exportCommand({ project, format: 'json', path: 'x/o.json', status: 'open' }, fakeIo(), deps);
    expect(fs.existsSync(path.join(project, 'x', 'o.json'))).toBe(true);
    await expect(exportCommand({ project, path: '../nope.csv' }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
    await expect(exportCommand({ project, format: 'xml' }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
  });
});

describe('csv', () => {
  it('escapes per RFC 4180', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell('سلام')).toBe('سلام');
    expect(csvCell(null)).toBe('');
    expect(csvCell(5)).toBe('5');
    expect(csvCell('-5 items')).toBe("'-5 items");
    expect(toCsv([]).startsWith('﻿id,status')).toBe(true);
  });
});
