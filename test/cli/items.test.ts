import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportCommand, itemsCommand, itemStatusCommand } from '../../src/cli/commands/items.js';
import { initCommand } from '../../src/cli/commands/init.js';
import { openStore } from '../../src/cli/open.js';
import { CliError } from '../../src/cli/io.js';
import { resolvePaths } from '../../src/core/paths.js';
import { fakeDeps, fakeIo, msg, seed, tmpProject } from './helpers.js';
import { toCsv, csvCell, formatPhone } from '../../src/export/index.js';

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

describe('leads export', () => {
  it('writes only leads, with the author name, an Excel-safe phone and the message', async () => {
    seed(project, deps, [
      msg({ id: 'b1', chatId: '1@g.us', ts: 1_700_000_100, senderId: '923001234567@s.whatsapp.net', senderName: 'Bilal', text: 'Panadol 500 ka rate? 20 box chahiye' }),
      msg({ id: 'b2', chatId: '1@g.us', ts: 1_700_000_200, senderId: '12345@lid', senderName: 'NoPhone', text: '=HYPERLINK("x")' }),
    ]);
    const { store, close } = openStore(resolvePaths(project), deps, { write: true });
    store.upsertContact({ id: '923001234567@s.whatsapp.net', savedName: 'Bilal Pharma' });
    store.saveItems([
      { chatId: '1@g.us', messageId: 'b1', category: 'lead', department: null, priority: 'high', summary: 'Wants 20 boxes Panadol 500', requester: null },
      { chatId: '1@g.us', messageId: 'b2', category: 'lead', department: null, priority: 'normal', summary: 'Asked for a link', requester: null },
    ]);
    close();
    const io = fakeIo();
    await exportCommand({ project, format: 'csv', category: 'lead' }, io, deps);
    expect(io.text()).toMatch(/Exported 2 items to \.chatai\/exports\/leads-/);
    const file = fs.readdirSync(path.join(project, '.chatai', 'exports')).find((f) => f.startsWith('leads-')) as string;
    const csv = fs.readFileSync(path.join(project, '.chatai', 'exports', file), 'utf8');
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('id,status,priority,contact,phone,chat_name,signal,message,message_at,ref,created_at');
    expect(lines).toHaveLength(3); // the two request/fyi items are left out
    expect(lines[1]).toContain(',Bilal Pharma,+92 300 1234567,');
    expect(lines[1]).toContain('Panadol 500 ka rate? 20 box chahiye');
    expect(lines[2]).toContain(',NoPhone,,'); // LID-only author: no phone
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`); // formula guard still on for message text
    await expect(exportCommand({ project, category: 'buyers' }, fakeIo(), deps)).rejects.toBeInstanceOf(CliError);
  });

  it('finds the saved name and phone of an author known by LID', async () => {
    seed(project, deps, [msg({ id: 'l1', chatId: '1@g.us', ts: 1_700_000_300, senderId: '555@lid', senderName: 'push', text: 'rate?' })]);
    const { store, close } = openStore(resolvePaths(project), deps, { write: true });
    store.upsertContact({ id: '923339998888@s.whatsapp.net', lid: '555@lid', savedName: 'Kamran' });
    store.saveItems([{ chatId: '1@g.us', messageId: 'l1', category: 'lead', department: null, priority: 'high', summary: 'rate', requester: null }]);
    close();
    await exportCommand({ project, format: 'json', category: 'lead', path: 'l.json' }, fakeIo(), deps);
    const out = JSON.parse(fs.readFileSync(path.join(project, 'l.json'), 'utf8')) as { leads: { contact: string; phone: string }[] };
    expect(out.leads[0]).toMatchObject({ contact: 'Kamran', phone: '+92 333 9998888' });
  });

  it('formats phones so Excel keeps them as text', () => {
    expect(formatPhone('923001234567@s.whatsapp.net')).toBe('+92 300 1234567');
    expect(formatPhone('12025550123@s.whatsapp.net')).toBe('+1 202 5550123');
    expect(formatPhone('12345@lid')).toBeNull();
    expect(csvCell('+92 300 1234567')).toBe('+92 300 1234567');
    expect(csvCell('+923001234567')).toBe("'+923001234567");
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
