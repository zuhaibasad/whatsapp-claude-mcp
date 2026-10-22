// Plain download + decrypt of a received image from WhatsApp's CDN (no socket, no re-upload request).
// Lives under src/daemon/wa/ because only this folder may import baileys (read-only guard).
import type { MediaRef } from '../../core/types.js';

/** Thrown by a downloader when WhatsApp no longer has the file (404/410). */
export class MediaExpiredError extends Error {}

export type MediaDownloader = (ref: MediaRef, maxBytes: number) => Promise<Buffer>;

/** Default downloader: Baileys' plain download-and-decrypt (no socket, no re-upload request). */
export const baileysDownloader: MediaDownloader = async (ref, maxBytes) => {
  const { downloadContentFromMessage } = await import('baileys');
  let stream;
  try {
    stream = await downloadContentFromMessage(
      { mediaKey: Buffer.from(ref.mediaKey, 'base64'), directPath: ref.directPath ?? undefined, url: ref.url ?? undefined },
      'image',
    );
  } catch (e) {
    const status = (e as { output?: { statusCode?: number } }).output?.statusCode;
    const msg = e instanceof Error ? e.message : '';
    if (status === 404 || status === 410 || /\b(404|410)\b/.test(msg)) throw new MediaExpiredError('expired');
    throw e;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new RangeError('too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

