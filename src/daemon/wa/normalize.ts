// Pure functions: Baileys WAMessage -> our RawMessage. No socket access, no downloads.
import { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import type { RawMessage } from '../../core/contracts.js';

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

function contextInfoOf(c: Content): proto.IContextInfo | null {
  for (const v of Object.values(c as Record<string, unknown>)) {
    if (v && typeof v === 'object' && 'contextInfo' in v) {
      const ci = (v as { contextInfo?: proto.IContextInfo | null }).contextInfo;
      if (ci) return ci;
    }
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

export function normalizeMessage(m: WAMessage, meId: string): RawMessage | null {
  const chatId = m.key?.remoteJid;
  const id = m.key?.id;
  if (!chatId || !id || !m.message) return null;
  if (chatId.endsWith('@broadcast')) return null; // includes status@broadcast

  const content = peel(m.message, false);
  if (!content) return null;
  if (content.protocolMessage || content.reactionMessage || content.pollUpdateMessage) return null;

  const text = textOf(content);
  const mediaType = mediaTypeOf(content);
  if (text === null && mediaType === null) return null;

  const ci = contextInfoOf(content);
  return {
    id,
    chatId,
    senderId: senderOf(m, meId),
    senderName: nonEmpty(m.pushName),
    ts: toNumber(m.messageTimestamp),
    text,
    quotedId: nonEmpty(ci?.stanzaId),
    quotedSenderId: nonEmpty(ci?.participant),
    mentions: (ci?.mentionedJid ?? []).filter((j): j is string => typeof j === 'string'),
    isFromMe: !!m.key.fromMe,
    hasMedia: mediaType !== null,
    mediaType,
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
