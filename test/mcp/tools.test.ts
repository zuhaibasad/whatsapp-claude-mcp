import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clip, ToolError } from '../../src/mcp/server.js';
import { G1, G2, T0, harness, msg, type Harness } from './helpers.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => h.cleanup());

describe('read tools', () => {
  it('list_chats shape, filter and unreviewed', async () => {
    h.store.insertMessage(msg({ ts: T0 - 100 }));
    h.store.insertMessage(msg({ ts: T0 - 90, chatId: G2 }));
    h.store.upsertChat({ id: '9@s.whatsapp.net', type: 'direct', name: 'Bob' });
    const r = await h.call('list_chats');
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain('\n');
    expect(r.json.chats).toHaveLength(2);
    expect(r.json.chats.find((c: { id: string }) => c.id === G1)).toMatchObject({
      name: 'ERP Support 🚀', type: 'group', participants: 3, unreviewed: 1, included: true,
    });
    expect(r.json.chats[0].last_message_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    const all = await h.call('list_chats', { filter: 'all' });
    expect(all.json.chats.length).toBeGreaterThanOrEqual(3);
    const active = await h.call('list_chats', { only_active_since: '1h' });
    expect(active.json.chats.map((c: { id: string }) => c.id).sort()).toEqual([G1, G2].sort());
  });

  it('get_new_messages: shape, mentions_me, reply_to, media, deleted, text clipping', async () => {
    h.store.insertMessage(msg({ id: 'a', ts: T0 - 50, text: 'x'.repeat(5000), mentionReason: 'at_mention', hasMedia: true, mediaType: 'image', quotedId: 'q1' }));
    h.store.insertMessage(msg({ id: 'b', ts: T0 - 40, text: 'ye kaam kab hoga؟ 🙏' }));
    h.store.markDeleted(G1, 'b');
    const r = await h.call('get_new_messages');
    expect(r.json.since).toBe('last_review');
    expect(r.json.truncated).toBe(false);
    const ms = r.json.chats[0].messages;
    expect(ms[0]).toMatchObject({ ref: `${G1}/a`, from: 'Ali', reply_to: `${G1}/q1`, mentions_me: true, media: 'image', edited: false, deleted: false });
    expect([...ms[0].text].length).toBeLessThan(2100);
    expect(ms[0].text).toContain('[truncated]');
    expect(ms[1]).toMatchObject({ deleted: true, text: null });
  });

  it('get_new_messages respects limit and sets truncated', async () => {
    for (let i = 0; i < 5; i++) h.store.insertMessage(msg({ ts: T0 - 100 + i }));
    const r = await h.call('get_new_messages', { limit: 3 });
    expect(r.json.truncated).toBe(true);
    expect(r.json.chats[0].messages).toHaveLength(3);
  });

  it('get_new_messages applies a total size budget', async () => {
    const long = 'ا'.repeat(1900);
    for (let i = 0; i < 80; i++) h.store.insertMessage(msg({ ts: T0 - 1000 + i, text: long }));
    const r = await h.call('get_new_messages', { limit: 500 });
    expect(r.json.truncated).toBe(true);
    expect(r.json.chats[0].messages.length).toBeLessThan(80);
    expect(r.json.chats[0].messages.length).toBeGreaterThan(10);
  });

  it('last_review works after mark_reviewed', async () => {
    h.store.insertMessage(msg({ ts: T0 - 300 }));
    h.store.insertMessage(msg({ ts: T0 - 200 }));
    expect((await h.call('get_new_messages')).json.chats[0].messages).toHaveLength(2);
    const iso = new Date((T0 - 250) * 1000).toISOString();
    const mr = await h.call('whatsapp_mark_reviewed', { until: iso });
    expect(mr.json.updated).toBeGreaterThan(0);
    expect((await h.call('get_new_messages')).json.chats[0].messages).toHaveLength(1);
    await h.call('whatsapp_mark_reviewed', { chats: ['ERP support 🚀'], until: new Date(T0 * 1000).toISOString() });
    expect((await h.call('get_new_messages')).json.chats).toHaveLength(0);
  });

  it('get_new_messages with since ISO and chat name filter', async () => {
    h.store.insertMessage(msg({ ts: T0 - 500 }));
    h.store.insertMessage(msg({ ts: T0 - 100, chatId: G2 }));
    const r = await h.call('get_new_messages', { since: new Date((T0 - 200) * 1000).toISOString(), chats: ['اردو گروپ'] });
    expect(r.json.chats.map((c: { id: string }) => c.id)).toEqual([G2]);
    expect(r.json.since).toMatch(/T/);
  });

  it('get_messages returns the latest N oldest-first, and resolves by name fragment', async () => {
    for (let i = 0; i < 6; i++) h.store.insertMessage(msg({ id: `x${i}`, ts: T0 - 100 + i, text: `msg ${i}` }));
    const r = await h.call('get_messages', { chat: 'erp', limit: 3 });
    expect(r.json.chat).toEqual({ id: G1, name: 'ERP Support 🚀' });
    expect(r.json.truncated).toBe(true);
    expect(r.json.messages.map((m: { text: string }) => m.text)).toEqual(['msg 3', 'msg 4', 'msg 5']);
    const since = await h.call('get_messages', { chat: G1, since: new Date((T0 - 98) * 1000).toISOString(), until: new Date((T0 - 97) * 1000).toISOString() });
    expect(since.json.messages.map((m: { text: string }) => m.text)).toEqual(['msg 2', 'msg 3']);
  });

  it('get_messages errors on unknown, ambiguous and excluded chats', async () => {
    h.store.upsertChat({ id: '333@g.us', type: 'group', name: 'ERP Support 2' });
    const amb = await h.call('get_messages', { chat: 'ERP Support' });
    expect(amb.isError).toBe(true);
    expect(amb.text).toContain('matches 2 chats');
    expect((await h.call('get_messages', { chat: 'nope' })).text).toContain('no chat matches');
    h.store.setChatIncluded(G2, false);
    expect((await h.call('get_messages', { chat: G2 })).text).toContain('excluded');
  });

  it('search_messages finds Urdu and English with chat_name and snippet', async () => {
    h.store.insertMessage(msg({ id: 's1', text: 'invoice bhej do please', ts: T0 - 20 }));
    h.store.insertMessage(msg({ id: 's2', text: 'رپورٹ تیار ہے', ts: T0 - 10, chatId: G2 }));
    const en = await h.call('search_messages', { query: 'invoice' });
    expect(en.json.hits[0]).toMatchObject({ chat_name: 'ERP Support 🚀', ref: `${G1}/s1` });
    expect(en.json.hits[0].snippet).toContain('invoice');
    const ur = await h.call('search_messages', { query: 'رپورٹ', chats: ['اردو گروپ'] });
    expect(ur.json.hits).toHaveLength(1);
    expect((await h.call('search_messages', { query: '"((' })).isError).toBe(false);
  });

  it('get_mentions returns reason and chat_name', async () => {
    h.store.insertMessage(msg({ id: 'r1', ts: T0 - 30, mentionReason: 'reply', quotedId: 'mine' }));
    h.store.insertMessage(msg({ id: 'r2', ts: T0 - 20 }));
    const r = await h.call('get_mentions');
    expect(r.json.mentions).toHaveLength(1);
    expect(r.json.mentions[0]).toMatchObject({ chat_name: 'ERP Support 🚀', reason: 'reply', mentions_me: true, ref: `${G1}/r1` });
  });

  it('get_chat_info lists participants', async () => {
    h.store.replaceParticipants(G1, [
      { contactId: 'a@s.whatsapp.net', displayName: 'Ali', isAdmin: true },
      { contactId: 'b@s.whatsapp.net', displayName: null, isAdmin: false },
    ]);
    const r = await h.call('get_chat_info', { chat: 'erp support 🚀' });
    expect(r.json).toEqual({
      id: G1, name: 'ERP Support 🚀', type: 'group', included: true,
      participants: [{ id: 'a@s.whatsapp.net', name: 'Ali', admin: true }, { id: 'b@s.whatsapp.net', name: null, admin: false }],
    });
  });
});

describe('get_status', () => {
  it('reports account, counts and daemon state', async () => {
    h.store.setMeta('last_sync_at', String(T0 - 180));
    h.store.setMeta('collector_state', 'live');
    h.store.insertMessage(msg());
    const r = await h.call('get_status');
    expect(r.json).toMatchObject({
      account: '+923001234567', link_status: 'linked', daemon_running: true, minutes_since_sync: 3,
      counts: { chats_included: 2, messages: 1, open_items: 0 }, warnings: [],
    });
  });
  it('warns when the daemon is down', async () => {
    const h2 = harness({ readLock: () => null });
    const r = await h2.call('get_status');
    expect(r.json.daemon_running).toBe(false);
    expect(r.json.warnings.join(' ')).toContain('collector is not running');
    h2.cleanup();
  });
  it('does not fail when not initialised', async () => {
    const h2 = harness({ openStore: () => { throw new ToolError('not initialised: run `wa-bridge init`'); } });
    const r = await h2.call('get_status');
    expect(r.isError).toBe(false);
    expect(r.json.warnings[0]).toContain('not initialised');
    h2.cleanup();
  });
});

describe('errors', () => {
  it('returns short actionable errors, no stack traces', async () => {
    const h2 = harness({ openStore: () => { throw new ToolError('not initialised: run `wa-bridge init`'); } });
    const r = await h2.call('list_chats');
    expect(r).toMatchObject({ isError: true, text: 'not initialised: run `wa-bridge init`' });
    h2.cleanup();
  });
  it('rejects bad arguments and bad times', async () => {
    expect((await h.call('get_messages', {})).text).toContain('invalid arguments');
    expect((await h.call('whatsapp_mark_reviewed', { until: 'yesterday-ish' })).text).toContain('invalid until');
    expect((await h.call('update_item', { id: 999, status: 'done' })).text).toContain('no item');
  });
});

describe('items', () => {
  it('save, dedupe, list, update', async () => {
    // The store stamps items with the real clock, so run this one with a clock two hours ahead of it.
    const real = harness({ now: () => Date.now() + 2 * 3600_000 });
    h.cleanup();
    h = real;
    h.store.insertMessage(msg({ id: 'i1', ts: Math.floor(Date.now() / 1000) }));
    const item = { ref: `${G1}/i1`, category: 'request', priority: 'high', summary: 'Send invoice', department: 'Finance', requester: 'Ali' };
    const a = await h.call('save_items', { items: [item] });
    expect(a.json).toMatchObject({ saved: 1, duplicates: 0 });
    const b = await h.call('save_items', { items: [item] });
    expect(b.json).toMatchObject({ saved: 0, duplicates: 1, ids: a.json.ids });
    const list = await h.call('list_items', { status: 'open' });
    expect(list.json.items[0]).toMatchObject({ ref: `${G1}/i1`, chat_name: 'ERP Support 🚀', age_hours: expect.closeTo(2, 0), summary: 'Send invoice', status: 'open' });
    expect((await h.call('update_item', { id: a.json.ids[0], status: 'done' })).json).toEqual({ id: a.json.ids[0], status: 'done' });
    expect((await h.call('list_items', { status: 'open' })).json.items).toHaveLength(0);
  });
  it('rejects malformed and unknown refs', async () => {
    const base = { category: 'fyi', priority: 'low', summary: 's' };
    expect((await h.call('save_items', { items: [{ ...base, ref: 'nochat' }] })).text).toContain('invalid ref');
    expect((await h.call('save_items', { items: [{ ...base, ref: `${G1}/ghost` }] })).text).toContain('unknown ref');
  });
});

describe('export_items', () => {
  beforeEach(async () => {
    h.store.insertMessage(msg({ id: 'e1' }));
    await h.call('save_items', {
      items: [{ ref: `${G1}/e1`, category: 'request', priority: 'high', summary: 'Fix "login", urgent\nدوبارہ دیکھیں', requester: '=SUM(A1)' }],
    });
  });
  it('writes csv with BOM at the default path', async () => {
    const r = await h.call('export_items', { format: 'csv' });
    expect(r.json.count).toBe(1);
    expect(r.json.path).toMatch(/^\.wa-bridge\/exports\/items-\d{4}-\d\d-\d\d\.csv$/);
    const raw = fs.readFileSync(path.join(h.dir, r.json.path), 'utf8');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain('"Fix ""login"", urgent\nدوبارہ دیکھیں"');
    expect(raw).toContain("'=SUM(A1)");
  });
  it('writes json to a custom path', async () => {
    const r = await h.call('export_items', { format: 'json', path: 'out/items.json' });
    expect(r.json).toEqual({ path: 'out/items.json', count: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'out/items.json'), 'utf8')).items[0].ref).toBe(`${G1}/e1`);
  });
  it('rejects paths outside the project folder', async () => {
    for (const p of ['../evil.csv', path.join(path.dirname(h.dir), 'evil.csv'), 'a/../../evil.csv']) {
      const r = await h.call('export_items', { format: 'csv', path: p });
      expect(r.isError, p).toBe(true);
      expect(r.text).toContain('inside the project folder');
    }
    expect(fs.existsSync(path.join(path.dirname(h.dir), 'evil.csv'))).toBe(false);
  });
  it('rejects a junction that escapes the project', async () => {
    const outside = fs.mkdtempSync(path.join(path.dirname(h.dir), 'wab-out-'));
    try {
      fs.symlinkSync(outside, path.join(h.dir, 'link'), 'junction');
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return; // cannot create links here
    }
    const r = await h.call('export_items', { format: 'csv', path: 'link/x.csv' });
    expect(r.isError).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('clip', () => {
  it('never splits emoji', () => {
    expect(clip('🚀🚀🚀', 2)).toBe('🚀🚀… [truncated]');
    expect(clip('abc', 5)).toBe('abc');
  });
});
