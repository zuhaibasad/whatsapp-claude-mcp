// Turns WaClient events into store writes. Applies chat filters, mention detection and text caps.
// Logs counters only, never message text.
import type { ChatMeta, Config, GroupMeta, RawMessage, Store } from '../core/contracts.js';
import type { Logger } from '../core/logger.js';
import type { Chat, ChatType, Contact } from '../core/types.js';
import { isChatIncluded } from '../config/index.js';
import { detectMention } from './mentions.js';

export interface IngestMe {
  id: string;
  lid: string | null;
  names: string[];
}

export interface IngestCounters {
  ingested: number;
  skipped_excluded: number;
  duplicates: number;
}

function chatTypeOf(id: string): ChatType {
  if (id.endsWith('@g.us')) return 'group';
  return id.endsWith('@newsletter') ? 'channel' : 'direct';
}

const bestName = (c: Contact | null): string | null => c?.savedName ?? c?.pushName ?? c?.verifiedName ?? null;

export class Ingestor {
  readonly counters: IngestCounters = { ingested: 0, skipped_excluded: 0, duplicates: 0 };

  constructor(
    private readonly store: Store,
    private readonly getConfig: () => Config,
    private readonly me: () => IngestMe | null,
    private readonly logger: Logger,
    /** Called instead of silently dropping a message from an excluded chat. The daemon does not set it. */
    public onExcluded?: (msg: RawMessage) => void,
  ) {}

  private included(chat: { id: string; name: string | null; type: ChatType }): boolean {
    return isChatIncluded(this.getConfig(), chat);
  }

  /** Best known contact name for a JID (phone or LID form), from the store. */
  private contactName(id: string): string | null {
    return bestName(this.store.getContact(id));
  }

  onChats(chats: ChatMeta[]): void {
    for (const c of chats) {
      const existing = this.store.getChat(c.id);
      const name = c.name ?? existing?.name ?? (c.type === 'direct' ? this.contactName(c.id) : null);
      const patch: Partial<Chat> & { id: string; type: ChatType } = {
        id: c.id,
        type: c.type,
        included: this.included({ id: c.id, name, type: c.type }),
      };
      if (name !== null) patch.name = name;
      if (c.muted !== undefined) patch.muted = c.muted;
      if (c.archived !== undefined) patch.archived = c.archived;
      this.store.upsertChat(patch);
      // Activity and unread count: timestamp and number only, recorded for excluded chats too.
      if (c.lastActivityAt !== undefined || c.unreadCount !== undefined) {
        this.store.touchChatActivity(c.id, c.lastActivityAt ?? 0, c.unreadCount, patch.included ?? false);
      }
    }
  }

  onGroups(groups: GroupMeta[]): void {
    for (const g of groups) {
      const existing = this.store.getChat(g.id);
      const name = g.subject ?? existing?.name ?? null;
      const patch: Partial<Chat> & { id: string; type: ChatType } = {
        id: g.id,
        type: 'group',
        participantCount: g.participants.length,
        included: this.included({ id: g.id, name, type: 'group' }),
      };
      if (name !== null) patch.name = name;
      this.store.upsertChat(patch);
      this.store.replaceParticipants(
        g.id,
        g.participants.map((p) => ({ contactId: p.id, displayName: p.displayName, isAdmin: p.isAdmin })),
      );
      for (const p of g.participants) {
        if (p.displayName) this.store.upsertContact({ id: p.id, pushName: p.displayName });
      }
    }
  }

  onContacts(contacts: (Partial<Contact> & { id: string })[]): void {
    for (const c of contacts) {
      this.store.upsertContact(c);
      if (c.lid && c.phoneJid) this.store.linkLid(c.lid, c.phoneJid);
      const stored = this.store.getContact(c.id);
      const name = bestName(stored);
      if (!name) continue;
      for (const key of new Set([c.id, stored?.phoneJid, stored?.lid])) {
        if (!key) continue;
        const chat = this.store.getChat(key);
        if (chat && chat.type === 'direct' && chat.name === null) {
          this.store.upsertChat({
            id: key, type: 'direct', name, included: this.included({ id: key, name, type: 'direct' }),
          });
        }
      }
    }
  }

  onLidMap(m: { lid: string; phoneJid: string }): void {
    this.store.linkLid(m.lid, m.phoneJid);
  }

  /** Metadata for every message, even from excluded chats. Stores a timestamp and a push name; never text. */
  onActivity(a: { chatId: string; ts: number; pushName: string | null; senderId: string }): void {
    if (!this.store.getChat(a.chatId)) {
      const type = chatTypeOf(a.chatId);
      const name = type === 'direct' ? this.contactName(a.chatId) : null;
      this.store.touchChatActivity(a.chatId, a.ts, undefined, this.included({ id: a.chatId, name, type }));
    } else {
      this.store.touchChatActivity(a.chatId, a.ts);
    }
    if (a.pushName && a.senderId && !a.senderId.endsWith('@g.us') && !a.senderId.endsWith('@newsletter')) {
      this.store.upsertContact({ id: a.senderId, pushName: a.pushName });
    }
  }

  onMessages(msgs: RawMessage[]): void {
    const config = this.getConfig();
    const me = this.me();
    for (const raw of msgs) {
      let chat = this.store.getChat(raw.chatId);
      if (!chat) {
        const type = chatTypeOf(raw.chatId);
        const name = type === 'direct' ? this.contactName(raw.chatId) : null;
        const included = this.included({ id: raw.chatId, name, type });
        this.store.upsertChat({ id: raw.chatId, type, ...(name !== null ? { name } : {}), included });
        chat = this.store.getChat(raw.chatId);
      }
      if (!chat?.included) {
        this.counters.skipped_excluded++;
        this.onExcluded?.(raw);
        continue;
      }
      const mentionReason = me ? detectMention(raw, me) : null;
      let text = raw.text;
      if (text !== null && text.length > config.maxTextChars) text = text.slice(0, config.maxTextChars);
      const inserted = this.store.insertMessage({
        ...raw,
        text,
        senderName: raw.senderName ?? this.contactName(raw.senderId),
        quotedSenderName: raw.quotedSenderName ?? (raw.quotedSenderId ? this.contactName(raw.quotedSenderId) : null),
        mentionReason,
      });
      if (inserted) this.counters.ingested++;
      else this.counters.duplicates++;
    }
    this.logger.debug({ ...this.counters, batch: msgs.length }, 'ingest batch');
  }

  onEdit(e: { chatId: string; messageId: string; newText: string }): void {
    const max = this.getConfig().maxTextChars;
    this.store.applyEdit(e.chatId, e.messageId, e.newText.length > max ? e.newText.slice(0, max) : e.newText);
  }

  onDelete(e: { chatId: string; messageId: string }): void {
    this.store.markDeleted(e.chatId, e.messageId);
  }

  /** Re-applies the config filters to every known chat. Returns the number of chats whose flag changed. */
  recomputeIncluded(): number {
    let changed = 0;
    for (const c of this.store.listChats()) {
      const inc = this.included(c);
      if (inc !== c.included) {
        this.store.setChatIncluded(c.id, inc);
        changed++;
      }
    }
    if (changed > 0) this.logger.info({ changed }, 'chat filters re-applied');
    return changed;
  }
}
