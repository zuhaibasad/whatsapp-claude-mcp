import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageInput } from '../../src/core/types.js';
import { SqliteStore } from '../../src/store/index.js';

const G = '1@g.us';
const ref = { kind: 'image' as const, mimetype: 'image/jpeg', fileLength: 1000, mediaKey: 'a2V5', directPath: '/v/t62/x', url: null };
const msg = (o: Partial<MessageInput>): MessageInput => ({
  id: 'm', chatId: G, senderId: 'a', senderName: 'Ali', ts: 100, text: null, quotedId: null, quotedSenderId: null,
  mentions: [], mentionReason: null, isFromMe: false, hasMedia: true, mediaType: 'image', ...o,
});

describe('store media', () => {
  let s: SqliteStore;
  beforeEach(() => {
    s = new SqliteStore(new Database(':memory:'));
    s.migrate();
    s.upsertChat({ id: G, type: 'group', name: 'Accounts', included: true });
  });

  it('queues an image on insert, once, and serves pending newest first', () => {
    s.insertMessage(msg({ id: 'a', ts: 100, media: ref }));
    s.insertMessage(msg({ id: 'b', ts: 200, media: ref }));
    s.insertMessage(msg({ id: 'b', ts: 200, media: ref })); // duplicate
    s.insertMessage(msg({ id: 'c', ts: 300, hasMedia: false, mediaType: null, text: 'x' }));
    const p = s.nextPendingMedia(1_000, 10);
    expect(p.map((m) => m.messageId)).toEqual(['b', 'a']);
    expect(p[0]).toMatchObject({ mediaKey: 'a2V5', directPath: '/v/t62/x', attempts: 0 });
    expect(s.getMediaInfo(G, 'a')).toMatchObject({ status: 'pending', hasBytes: false, ocrText: null });
  });

  it('saves the result, drops the download keys and makes the OCR text searchable', () => {
    s.insertMessage(msg({ id: 'a', media: ref }));
    s.saveMediaResult(G, 'a', {
      status: 'done', bytes: Buffer.from('jpegbytes'), ocrText: 'Meezan Bank PKR 45,000 TX88231907',
      ocrFields: { amount: 'PKR 45,000' }, ocrConfidence: 0.9,
    });
    expect(s.nextPendingMedia(1_000, 10)).toEqual([]);
    expect(s.getMediaInfo(G, 'a')).toMatchObject({ status: 'done', hasBytes: true, size: 9, ocrFields: { amount: 'PKR 45,000' }, ocrConfidence: 0.9 });
    expect(s.getMediaBytes(G, 'a')?.bytes.toString()).toBe('jpegbytes');
    const hits = s.searchMessages('TX88231907', { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('[image text]');
    expect(s.listMedia({ limit: 10 })[0]).toMatchObject({ messageId: 'a', chatName: 'Accounts' });
  });

  it('retries, then gives up', () => {
    s.insertMessage(msg({ id: 'a', media: ref }));
    s.markMediaRetry(G, 'a', 500, false);
    expect(s.nextPendingMedia(400, 10)).toEqual([]);
    expect(s.nextPendingMedia(500, 10)[0]?.attempts).toBe(1);
    s.markMediaRetry(G, 'a', 900, true);
    expect(s.getMediaInfo(G, 'a')?.status).toBe('failed');
  });

  it('caps stored bytes oldest first, keeping OCR text, and purges with retention', () => {
    for (const [id, ts] of [['a', 100], ['b', 200], ['c', 300]] as const) {
      s.insertMessage(msg({ id, ts, media: ref }));
      s.saveMediaResult(G, id, { status: 'done', bytes: Buffer.alloc(100), ocrText: `text ${id}` });
    }
    expect(s.capMediaBytes(250)).toBe(1);
    expect(s.getMediaInfo(G, 'a')).toMatchObject({ hasBytes: false, ocrText: 'text a' });
    expect(s.getMediaInfo(G, 'c')?.hasBytes).toBe(true);
    s.purgeOlderThan(250);
    expect(s.getMediaInfo(G, 'b')).toBeNull();
    expect(s.searchMessages('text', { limit: 10 }).map((h) => h.message.id)).toEqual(['c']);
  });
});
