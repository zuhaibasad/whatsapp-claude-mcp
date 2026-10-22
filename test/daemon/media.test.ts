import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/contracts.js';
import type { MessageInput } from '../../src/core/types.js';
import { MediaExpiredError, MediaWorker, tesseractEngine, type MediaDownloader, type OcrEngine } from '../../src/daemon/media.js';
import { SqliteStore } from '../../src/store/index.js';

const G = '1@g.us';
const ref = { kind: 'image' as const, mimetype: 'image/jpeg', fileLength: 1000, mediaKey: 'a2V5', directPath: '/p', url: null };
const msg = (id: string, o: Partial<MessageInput> = {}): MessageInput => ({
  id, chatId: G, senderId: 'a', senderName: null, ts: 100, text: null, quotedId: null, quotedSenderId: null,
  mentions: [], mentionReason: null, isFromMe: false, hasMedia: true, mediaType: 'image', media: ref, ...o,
});
const config = { mediaDownload: true, mediaOcr: true, mediaMaxMb: 500 } as Config;
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const ocr: OcrEngine = { recognize: () => Promise.resolve({ text: 'Total PKR 1,500\nTID: AB123456', confidence: 0.88 }), close: () => Promise.resolve() };

describe('MediaWorker', () => {
  let s: SqliteStore;
  beforeEach(() => {
    s = new SqliteStore(new Database(':memory:'));
    s.migrate();
    s.upsertChat({ id: G, type: 'group', name: 'Accounts', included: true });
  });

  const worker = (download: MediaDownloader, cfg: Partial<Config> = {}) =>
    new MediaWorker({ store: s, getConfig: () => ({ ...config, ...cfg }), logger, download, ocr, nowSec: () => 1_000 });

  it('downloads, reads and stores fields', async () => {
    s.insertMessage(msg('a'));
    await worker(() => Promise.resolve(Buffer.from('img'))).kick();
    expect(s.getMediaInfo(G, 'a')).toMatchObject({
      status: 'done', hasBytes: true, ocrConfidence: 0.88, ocrFields: { amount: 'PKR 1,500', reference: 'AB123456' },
    });
  });

  it('marks expired, too large, and retries other errors', async () => {
    s.insertMessage(msg('exp', { media: { ...ref, directPath: '/gone' } }));
    s.insertMessage(msg('big', { media: { ...ref, fileLength: 50 * 1024 * 1024 } }));
    s.insertMessage(msg('net'));
    await worker((r) => Promise.reject(r.directPath === '/gone' ? new MediaExpiredError('x') : new Error('net'))).kick();
    expect(s.getMediaInfo(G, 'exp')?.status).toBe('expired');
    expect(s.getMediaInfo(G, 'big')?.status).toBe('too_large');
    expect(s.getMediaInfo(G, 'net')?.status).toBe('pending');
    expect(s.nextPendingMedia(1_000, 10)).toEqual([]); // scheduled for later
  });

  it('does nothing when media_download is off; skips OCR when media_ocr is off', async () => {
    s.insertMessage(msg('a'));
    await worker(() => Promise.resolve(Buffer.from('img')), { mediaDownload: false }).kick();
    expect(s.getMediaInfo(G, 'a')?.status).toBe('pending');
    await worker(() => Promise.resolve(Buffer.from('img')), { mediaOcr: false }).kick();
    expect(s.getMediaInfo(G, 'a')).toMatchObject({ status: 'done', ocrText: null, hasBytes: true });
  });
});

describe('tesseractEngine (real, local)', () => {
  it('reads the sample receipt', async () => {
    const e = tesseractEngine();
    try {
      const r = await e.recognize(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'media', 'receipt.jpg')));
      expect(r.text).toContain('45,000');
      expect(r.text).toContain('TX88231907');
      expect(r.confidence).toBeGreaterThan(0.7);
    } finally {
      await e.close();
    }
  }, 60_000);
});
