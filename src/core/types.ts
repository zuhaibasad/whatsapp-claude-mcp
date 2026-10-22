// Shared domain types. All timestamps are unix SECONDS (integers) unless named *Iso.
// Chat ids and contact ids are WhatsApp JIDs as strings (e.g. "1203...@g.us", "92300...@s.whatsapp.net", "...@lid").

/** 'channel' = WhatsApp Channels (newsletters, JID suffix @newsletter). */
export type ChatType = 'group' | 'direct' | 'channel';
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
  /** Last activity timestamp, also for excluded chats (no content). */
  lastActivityAt?: number | null;
  unreadCount?: number | null;
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
  /** Text of the quoted message from contextInfo.quotedMessage (max 300 chars; `[image]` etc. for media). Untrusted data. */
  quotedText?: string | null;
  /** Display name of the quoted message's sender when known. */
  quotedSenderName?: string | null;
  /** Location / contact card payloads, stored as JSON in messages.extra. Untrusted data. */
  extra?: MessageExtra | null;
}

export interface MessageExtra {
  location?: { lat: number; lng: number; name?: string; address?: string };
  contacts?: { name: string; phones: string[] }[];
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

/** Contact metadata (no message content). Persisted so names survive restarts. */
export interface Contact {
  id: string;                 // primary JID as WhatsApp gives it (@s.whatsapp.net or @lid)
  phoneJid: string | null;    // phone-number JID if known (from LID mapping)
  lid: string | null;         // LID JID if known
  savedName: string | null;   // name from the user's address book (app-state sync)
  pushName: string | null;    // name the contact set for themselves
  verifiedName: string | null;// business verified name
  updatedAt: number;
}
