import type { MentionReason } from '../core/types.js';
import type { RawMessage } from '../core/contracts.js';

/**
 * Strips the device suffix and lowercases a WhatsApp JID.
 * "92300…:12@s.whatsapp.net" -> "92300…@s.whatsapp.net"
 */
export function normalizeJid(jid: string): string {
  const at = jid.lastIndexOf('@');
  if (at < 0) return jid.toLowerCase();
  const user = jid.slice(0, at).split(':')[0] ?? '';
  const server = jid.slice(at + 1);
  return `${user}@${server}`.toLowerCase();
}

const MIN_NAME_LENGTH = 2;
const WORD_CHAR = '\\p{L}\\p{N}';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function nameMatches(text: string, names: string[]): boolean {
  for (const raw of names) {
    const name = raw.trim();
    if (name.length < MIN_NAME_LENGTH) continue;
    const re = new RegExp(
      `(?<![${WORD_CHAR}])${escapeRegex(name)}(?![${WORD_CHAR}])`,
      'iu',
    );
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Decides whether a message is addressed to me. Priority: at_mention, then reply, then name.
 * Returns null for my own messages and for messages not addressed to me.
 */
export function detectMention(
  msg: RawMessage,
  me: { id: string; lid: string | null; names: string[] },
): MentionReason | null {
  if (msg.isFromMe) return null;

  const myIds = new Set<string>([normalizeJid(me.id)]);
  if (me.lid) myIds.add(normalizeJid(me.lid));

  if (msg.mentions.some((j) => myIds.has(normalizeJid(j)))) return 'at_mention';

  if (msg.quotedSenderId && myIds.has(normalizeJid(msg.quotedSenderId))) return 'reply';

  if (msg.text && nameMatches(msg.text, me.names)) return 'name';

  return null;
}
