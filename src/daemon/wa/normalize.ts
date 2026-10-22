// Pure functions: Baileys WAMessage -> our RawMessage. No socket access, no downloads.
import { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import type { RawMessage } from '../../core/contracts.js';
import type { MediaRef, MessageExtra } from '../../core/types.js';

type Content = proto.IMessage;
type EditResult = { chatId: string; messageId: string; newText: string };

const PT = proto.Message.ProtocolMessage.Type;

/** Unwraps ephemeral / view-once / caption / edited wrappers. With stopAtEdit, an `editedMessage` wrapper is left in place. */
function peel(content: Content, stopAtEdit: boolean): Content | undefined {
  let c: Content | null | undefined = content;
  for (let i = 0; i < 6 && c; i++) {
    if (stopAtEdit && c.editedMessage) return c;
    const inner: { message?: Content | null } | null | undefined =
      c.ephemeralMessage ??
      c.viewOnceMessage ??
      c.viewOnceMessageV2 ??
      c.viewOnceMessageV2Extension ??
      c.documentWithCaptionMessage ??
      c.editedMessage;
    if (!inner?.message) return c;
    c = inner.message;
  }
  return c ?? undefined;
}

/** Long | number | bigint | null -> number. */
export function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v) || 0;
  const o = v as { low?: number; high?: number; toNumber?: () => number };
  if (typeof o.toNumber === 'function') return o.toNumber();
  if (typeof o.low === 'number' && typeof o.high === 'number') return o.high * 4294967296 + (o.low >>> 0);
  return 0;
}

function nonEmpty(s: string | null | undefined): string | null {
  return typeof s === 'string' && s.length > 0 ? s : null;
}

function textOf(c: Content): string | null {
  return (
    nonEmpty(c.conversation) ??
    nonEmpty(c.extendedTextMessage?.text) ??
    nonEmpty(c.imageMessage?.caption) ??
    nonEmpty(c.videoMessage?.caption) ??
    nonEmpty(c.documentMessage?.caption) ??
    null
  );
}

const MEDIA_KINDS: [keyof Content, string][] = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['ptvMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
  ['contactMessage', 'contact'],
  ['contactsArrayMessage', 'contact'],
  ['locationMessage', 'location'],
  ['liveLocationMessage', 'location'],
];

function mediaTypeOf(c: Content): string | null {
  for (const [k, name] of MEDIA_KINDS) if (c[k]) return name;
  return null;
}

/** Download reference for an image (or a document that is an image). Null when keys are missing. */
function mediaRefOf(c: Content): MediaRef | null {
  const doc = c.documentMessage && (c.documentMessage.mimetype ?? '').startsWith('image/') ? c.documentMessage : null;
  const im = c.imageMessage ?? doc;
  if (!im?.mediaKey || im.mediaKey.length === 0 || (!im.directPath && !im.url)) return null;
  return {
    kind: 'image',
    mimetype: nonEmpty(im.mimetype),
    fileLength: im.fileLength === null || im.fileLength === undefined ? null : toNumber(im.fileLength),
    mediaKey: Buffer.from(im.mediaKey).toString('base64'),
    directPath: nonEmpty(im.directPath),
    url: nonEmpty(im.url),
  };
}

function contextInfoOf(c: Content): proto.IContextInfo | null {
  for (const v of Object.values(c as Record<string, unknown>)) {
    if (v && typeof v === 'object' && 'contextInfo' in v) {
      const ci = (v as { contextInfo?: proto.IContextInfo | null }).contextInfo;
      if (ci) return ci;
    }
  }
  return null;
}

const QUOTE_MAX = 300;

const clip300 = (t: string): string => {
  const chars = [...t];
  return chars.length <= QUOTE_MAX ? t : chars.slice(0, QUOTE_MAX).join('');
};

/** Text of a quoted message (text/caption, else a `[kind]` placeholder). Null when nothing usable. */
function quotedTextOf(ci: proto.IContextInfo | null): string | null {
  const q = ci?.quotedMessage;
  if (!q) return null;
  const inner = peel(q, false);
  if (!inner) return null;
  const t = textOf(inner);
  if (t !== null) return clip300(t);
  const kind = mediaTypeOf(inner);
  return kind ? `[${kind}]` : null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parses FN and TEL lines of a vCard. Pure string handling; untrusted input. */
export function parseVcard(vcard: string | null | undefined, fallbackName?: string | null): { name: string; phones: string[] } {
  let fn: string | null = null;
  const phones: string[] = [];
  for (const raw of (vcard ?? '').split(/\r?\n/)) {
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const key = raw.slice(0, idx).split(';')[0]?.trim().toUpperCase() ?? '';
    const val = raw.slice(idx + 1).trim();
    if (!val) continue;
    if (key === 'FN' && fn === null) fn = val;
    else if (key === 'TEL' || key.endsWith('.TEL')) phones.push(val);
  }
  return { name: clip300(fn ?? fallbackName ?? ''), phones: phones.slice(0, 10).map((p) => p.slice(0, 40)) };
}

/** Location or contact-card payload plus the placeholder text. Null for other content. */
function extraOf(c: Content): { extra: MessageExtra; text: string } | null {
  const loc = c.locationMessage ?? c.liveLocationMessage;
  if (loc && finite(loc.degreesLatitude) && finite(loc.degreesLongitude)) {
    const place = c.locationMessage;
    const name = nonEmpty(place?.name);
    const address = nonEmpty(place?.address);
    const location: NonNullable<MessageExtra['location']> = { lat: loc.degreesLatitude, lng: loc.degreesLongitude };
    if (name) location.name = clip300(name);
    if (address) location.address = clip300(address);
    return { extra: { location }, text: '[location]' };
  }
  const cards = c.contactsArrayMessage?.contacts ?? (c.contactMessage ? [c.contactMessage] : []);
  if (cards.length > 0) {
    const contacts = cards.slice(0, 10).map((k) => parseVcard(k.vcard, k.displayName));
    return { extra: { contacts }, text: '[contact card]' };
  }
  return null;
}

const isPn = (jid: string | null | undefined): jid is string => !!jid && jid.endsWith('@s.whatsapp.net');

function senderOf(m: WAMessage, meId: string): string {
  if (m.key.fromMe) return meId;
  const chat = m.key.remoteJid ?? '';
  if (chat.endsWith('@g.us')) {
    const alt = m.key.participantAlt;
    const p = m.key.participant ?? '';
    return isPn(alt) && !isPn(p) ? alt : p || chat;
  }
  const alt = m.key.remoteJidAlt;
  return isPn(alt) && !isPn(chat) ? alt : chat;
}

/** Seconds from a Baileys timestamp that may be a number, Long, or (rarely) milliseconds. */
export function toSeconds(v: unknown): number {
  const n = toNumber(v);
  return n > 1e11 ? Math.floor(n / 1000) : n;
}

/** Metadata-only view of a message: when, where, who. No text. Null for status/broadcast lists or when ts is unknown. */
export function activityOf(m: WAMessage, meId: string): { chatId: string; ts: number; pushName: string | null; senderId: string } | null {
  const chatId = m.key?.remoteJid;
  if (!chatId || chatId.endsWith('@broadcast')) return null;
  const ts = toSeconds(m.messageTimestamp);
  if (ts <= 0) return null;
  return { chatId, ts, pushName: m.key.fromMe ? null : nonEmpty(m.pushName), senderId: senderOf(m, meId) };
}

/** LID <-> phone pairs that Baileys hands us on message keys (remoteJidAlt / participantAlt). */
export function lidPairsOf(m: WAMessage): { lid: string; phoneJid: string }[] {
  const out: { lid: string; phoneJid: string }[] = [];
  const add = (a: string | null | undefined, b: string | null | undefined): void => {
    if (!a || !b) return;
    if (a.endsWith('@lid') && isPn(b)) out.push({ lid: a, phoneJid: b });
    else if (b.endsWith('@lid') && isPn(a)) out.push({ lid: b, phoneJid: a });
  };
  add(m.key?.remoteJid, m.key?.remoteJidAlt);
  add(m.key?.participant, m.key?.participantAlt);
  return out;
}

export function normalizeMessage(m: WAMessage, meId: string): RawMessage | null {
  const chatId = m.key?.remoteJid;
  const id = m.key?.id;
  if (!chatId || !id || !m.message) return null;
  if (chatId.endsWith('@broadcast')) return null; // includes status@broadcast

  const content = peel(m.message, false);
  if (!content) return null;
  if (content.protocolMessage || content.reactionMessage || content.pollUpdateMessage) return null;

  const card = extraOf(content);
  const text = textOf(content) ?? card?.text ?? null;
  const mediaType = mediaTypeOf(content);
  if (text === null && mediaType === null) return null;

  const ci = contextInfoOf(content);
  return {
    extra: card?.extra ?? null,
    quotedText: quotedTextOf(ci),
    quotedSenderName: null,
    id,
    chatId,
    senderId: senderOf(m, meId),
    senderName: nonEmpty(m.pushName),
    ts: toSeconds(m.messageTimestamp),
    text,
    quotedId: nonEmpty(ci?.stanzaId),
    quotedSenderId: nonEmpty(ci?.participant),
    mentions: (ci?.mentionedJid ?? []).filter((j): j is string => typeof j === 'string'),
    isFromMe: !!m.key.fromMe,
    hasMedia: mediaType !== null,
    mediaType,
    media: mediaRefOf(content),
  };
}

function editFrom(content: Content, chatId: string, ownId: string, depth = 0): EditResult | null {
  const c = peel(content, true);
  if (!c || depth > 3) return null;
  const pm = c.protocolMessage;
  if (pm && pm.type === PT.MESSAGE_EDIT && pm.key?.id && pm.editedMessage) {
    const inner = peel(pm.editedMessage, false);
    const newText = inner ? textOf(inner) : null;
    return newText ? { chatId, messageId: pm.key.id, newText } : null;
  }
  const wrapped = c.editedMessage?.message;
  if (wrapped) {
    const nested = editFrom(wrapped, chatId, ownId, depth + 1);
    if (nested) return nested;
    // rc14 `messages.update` shape: editedMessage.message is the new plain content, target id = key.id
    const plain = peel(wrapped, false);
    const newText = plain ? textOf(plain) : null;
    return newText ? { chatId, messageId: ownId, newText } : null;
  }
  return null;
}

/**
 * Edit from a WAMessage (a protocolMessage MESSAGE_EDIT, or the `editedMessage` wrapper shape that
 * Baileys puts in `messages.update`, where key.id is already the edited message's id).
 */
export function extractEdit(m: WAMessage): EditResult | null {
  const chatId = m.key?.remoteJid;
  const id = m.key?.id;
  if (!chatId || !id || !m.message) return null;
  return editFrom(m.message, chatId, id);
}

/** Revoke ("delete for everyone") from a protocolMessage type REVOKE. */
export function extractDelete(m: WAMessage): { chatId: string; messageId: string } | null {
  const chatId = m.key?.remoteJid;
  if (!chatId || !m.message) return null;
  const c = peel(m.message, true);
  const pm = c?.protocolMessage;
  if (pm && pm.type === PT.REVOKE && pm.key?.id) return { chatId, messageId: pm.key.id };
  return null;
}
