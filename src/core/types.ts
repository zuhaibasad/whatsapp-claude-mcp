// Shared domain types. All timestamps are unix SECONDS (integers) unless named *Iso.
// Chat ids and contact ids are WhatsApp JIDs as strings (e.g. "1203...@g.us", "92300...@s.whatsapp.net", "...@lid").

export type ChatType = 'group' | 'direct';
export type LinkStatus = 'unlinked' | 'linking' | 'connecting' | 'linked' | 'disconnected' | 'logged_out';

export interface Account {
  id: string;            // own JID, phone-number form
  lid: string | null;    // own LID form, mentions may use it
  pushName: string | null;
  linkStatus: LinkStatus;
  linkedAt: number | null;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
}

export interface Chat {
  id: string;
  type: ChatType;
  name: string | null;
  participantCount: number | null;
  muted: boolean;
  archived: boolean;
  included: boolean;
  lastMessageAt: number | null;
}

export interface Participant {
  chatId: string;
  contactId: string;
  displayName: string | null;
  isAdmin: boolean;
}

export type MentionReason = 'at_mention' | 'name' | 'reply';

/** A message as produced by the daemon's normalizer and written by the store. */
export interface MessageInput {
  id: string;
  chatId: string;
  senderId: string;          // for is_from_me = own JID
  senderName: string | null; // push name if known
  ts: number;
  text: string | null;       // caption for media; null if no text
  quotedId: string | null;
  quotedSenderId: string | null;
  mentions: string[];        // JIDs @-mentioned
  mentionReason: MentionReason | null; // null = not addressed to me
  isFromMe: boolean;
  hasMedia: boolean;
  mediaType: string | null;  // 'image' | 'video' | 'audio' | 'document' | 'sticker' | ...
}

export interface StoredMessage extends MessageInput {
  edited: boolean;
  deleted: boolean;
}

export type ItemCategory = 'critical' | 'mention' | 'request' | 'fyi';
export type ItemPriority = 'critical' | 'high' | 'normal' | 'low';
export type ItemStatus = 'open' | 'done' | 'dismissed';

export interface ItemInput {
  chatId: string;
  messageId: string;
  category: ItemCategory;
  department: string | null;
  priority: ItemPriority;
  summary: string;
  requester: string | null;
}

export interface Item extends ItemInput {
  id: number;
  status: ItemStatus;
  createdAt: number;
  updatedAt: number;
}
