// Turns WaClient events into store writes. Applies chat filters, mention detection and text caps.
// Logs counters only, never message text.
import type { ChatMeta, Config, GroupMeta, RawMessage, Store } from '../core/contracts.js';
import type { Logger } from '../core/logger.js';
import type { Chat, ChatType } from '../core/types.js';
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
  return id.endsWith('@g.us') ? 'group' : 'direct';
}

export class Ingestor {
  readonly counters: IngestCounters = { ingested: 0, skipped_excluded: 0, duplicates: 0 };
  private readonly contacts = new Map<string, string>();

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

  onChats(chats: ChatMeta[]): void {
    for (const c of chats) {
      const existing = this.store.getChat(c.id);
      const name = c.name ?? existing?.name ?? (c.type === 'direct' ? (this.contacts.get(c.id) ?? null) : null);
      const patch: Partial<Chat> & { id: string; type: ChatType } = {
        id: c.id,
        type: c.type,
        included: this.included({ id: c.id, name, type: c.type }),
      };
      if (name !== null) patch.name = name;
      if (c.muted !== undefined) patch.muted = c.muted;
      if (c.archived !== undefined) patch.archived = c.archived;
      this.store.upsertChat(patch);
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
    }
  }

  onContacts(contacts: { id: string; name: string | null }[]): void {
    for (const c of contacts) {
      if (!c.name) continue;
      this.contacts.set(c.id, c.name);
      const chat = this.store.getChat(c.id);
      if (chat && chat.type === 'direct' && chat.name === null) {
        this.store.upsertChat({
          id: c.id,
          type: 'direct',
          name: c.name,
          included: this.included({ id: c.id, name: c.name, type: 'direct' }),
        });
      }
    }
  }

  onMessages(msgs: RawMessage[]): void {
    const config = this.getConfig();
    const me = this.me();
    for (const raw of msgs) {
      let chat = this.store.getChat(raw.chatId);
      if (!chat) {
        const type = chatTypeOf(raw.chatId);
        const name = type === 'direct' ? (this.contacts.get(raw.chatId) ?? null) : null;
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
        senderName: raw.senderName ?? this.contacts.get(raw.senderId) ?? null,
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
