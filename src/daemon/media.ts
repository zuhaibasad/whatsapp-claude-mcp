// Background image pipeline: download (WhatsApp CDN, decrypt locally) -> OCR (tesseract, local) -> fields -> store.
// Read-only: it only fetches files the user already received. It never asks the phone to re-upload expired media.
// Logs ids and counters only, never OCR text.
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Config, Store } from '../core/contracts.js';
import type { Logger } from '../core/logger.js';
import type { MediaRef } from '../core/types.js';
import { extractOcrFields } from './ocr-fields.js';
import { baileysDownloader, MediaExpiredError, type MediaDownloader } from './wa/media-download.js';

export { MediaExpiredError, type MediaDownloader };

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OCR_TEXT = 4000;
const RETRY_S = [5 * 60, 30 * 60, 3 * 3600];
const BATCH = 5;

export interface OcrEngine {
  recognize(image: Buffer): Promise<{ text: string; confidence: number }>;
  close(): Promise<void>;
}

/** Tesseract (WASM, English, LSTM) loaded on first use, closed after idleMs without work. */
export function tesseractEngine(idleMs = 120_000): OcrEngine {
  type W = { recognize(img: Buffer): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };
  let worker: Promise<W> | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const close = async (): Promise<void> => {
    if (idle) clearTimeout(idle);
    idle = null;
    const w = worker;
    worker = null;
    if (w) await (await w).terminate().catch(() => undefined);
  };
  const get = (): Promise<W> => {
    if (!worker) {
      worker = (async () => {
        const { createWorker, OEM } = await import('tesseract.js');
        const req = createRequire(import.meta.url);
        const langPath = path.join(path.dirname(req.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
        return (await createWorker('eng', OEM.LSTM_ONLY, { langPath, gzip: true, cacheMethod: 'none' })) as unknown as W;
      })();
      worker.catch(() => { worker = null; });
    }
    return worker;
  };
  return {
    async recognize(image) {
      if (idle) clearTimeout(idle);
      try {
        const r = await (await get()).recognize(image);
        return { text: r.data.text, confidence: r.data.confidence / 100 };
      } finally {
        idle = setTimeout(() => void close(), idleMs);
        idle.unref?.();
      }
    },
    close,
  };
}

export interface MediaWorkerOptions {
  store: Store;
  getConfig: () => Config;
  logger: Logger;
  download?: MediaDownloader;
  ocr?: OcrEngine;
  nowSec?: () => number;
  pollMs?: number;
}

/** Works through pending media one at a time. kick() after new messages; stop() on shutdown. */
export class MediaWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  readonly counters = { done: 0, expired: 0, failed: 0, too_large: 0 };
  private readonly download: MediaDownloader;
  private readonly ocr: OcrEngine;
  private readonly nowSec: () => number;

  constructor(private readonly o: MediaWorkerOptions) {
    this.download = o.download ?? baileysDownloader;
    this.ocr = o.ocr ?? tesseractEngine();
    this.nowSec = o.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), this.o.pollMs ?? 60_000);
    this.timer.unref?.();
    this.kick();
  }

  /** Starts a pass unless one is running. Returns the running pass. */
  kick(): Promise<void> {
    if (this.stopped || !this.o.getConfig().mediaDownload) return Promise.resolve();
    this.running ??= this.pass()
      .catch((e: unknown) => { this.o.logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'media pass failed'); })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
    await this.ocr.close();
  }

  private async pass(): Promise<void> {
    const { store, logger } = this.o;
    for (;;) {
      if (this.stopped) return;
      const batch = store.nextPendingMedia(this.nowSec(), BATCH);
      if (batch.length === 0) break;
      for (const m of batch) {
        if (this.stopped) return;
        await this.one(m);
      }
    }
    const config = this.o.getConfig();
    const trimmed = store.capMediaBytes(config.mediaMaxMb * 1024 * 1024);
    if (trimmed > 0) logger.info({ trimmed }, 'media storage cap applied');
    logger.debug({ ...this.counters }, 'media pass done');
  }

  private async one(m: MediaRef & { chatId: string; messageId: string; attempts: number }): Promise<void> {
    const { store, logger } = this.o;
    const config = this.o.getConfig();
    if (m.fileLength !== null && m.fileLength > MAX_IMAGE_BYTES) {
      store.saveMediaResult(m.chatId, m.messageId, { status: 'too_large' });
      this.counters.too_large++;
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await this.download(m, MAX_IMAGE_BYTES);
    } catch (e) {
      if (e instanceof MediaExpiredError) {
        store.saveMediaResult(m.chatId, m.messageId, { status: 'expired' });
        this.counters.expired++;
      } else if (e instanceof RangeError) {
        store.saveMediaResult(m.chatId, m.messageId, { status: 'too_large' });
        this.counters.too_large++;
      } else {
        const giveUp = m.attempts + 1 >= RETRY_S.length;
        store.markMediaRetry(m.chatId, m.messageId, this.nowSec() + (RETRY_S[m.attempts] ?? 0), giveUp);
        if (giveUp) this.counters.failed++;
        logger.warn({ chat: m.chatId, id: m.messageId, err: e instanceof Error ? e.name : 'unknown' }, 'media download failed');
      }
      return;
    }
    let ocrText: string | null = null;
    let confidence: number | null = null;
    if (config.mediaOcr) {
      try {
        const r = await this.ocr.recognize(bytes);
        ocrText = r.text.trim().slice(0, MAX_OCR_TEXT) || null;
        confidence = Math.round(r.confidence * 100) / 100;
      } catch (e) {
        logger.warn({ chat: m.chatId, id: m.messageId, err: e instanceof Error ? e.name : 'unknown' }, 'ocr failed');
      }
    }
    store.saveMediaResult(m.chatId, m.messageId, {
      status: 'done', bytes, ocrText, ocrConfidence: confidence,
      ocrFields: ocrText ? extractOcrFields(ocrText) : null,
    });
    this.counters.done++;
  }
}
