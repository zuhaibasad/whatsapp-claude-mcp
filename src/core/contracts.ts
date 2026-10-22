// Interfaces between modules. Workers implement these exactly; change only via the orchestrator.
import type Database from 'better-sqlite3-multiple-ciphers';
import type {
  Account, Chat, ChatType, Item, ItemInput, ItemStatus, ItemPriority,
  MessageInput, MentionReason, Participant, StoredMessage,
} from './types.js';

export type Db = Database.Database;

// ---------- crypto (src/crypto) ----------

/** Thin wrapper over the OS keychain so tests can swap in a fake. */
export interface KeyringBackend {
  getPassword(service: string, account: string): string | null;
  setPassword(service: string, account: string, password: string): void;
  deletePassword(service: string, account: string): boolean;
}

/** Holds the 32-byte master key for one project folder. */
export interface MasterKeyStore {
  /** Returns the key, or null if `init` has not run. */
  get(): Buffer | null;
  /** Creates and saves a new random key. Throws if one already exists. */
  create(): Buffer;
  /** Removes the key. Returns false if there was none. */
  delete(): boolean;
}

export type DbPurpose = 'store' | 'auth';

// ---------- config (src/config) ----------
// YAML uses snake_case keys (retention_days, ...). The loader maps them to this camelCase shape.

export interface Config {
  retentionDays: number;          // default 30, min 1
  timezone: string;               // IANA, default = system zone
  includeGroups: boolean;         // default true
  includeDirectChats: boolean;    // default false
  allowlist: string[];            // chat JIDs or chat names (case-insensitive exact)
  denylist: string[];             // same; denylist wins over allowlist
  myNames: string[];              // names/nicknames for text mention detection
  maxTextChars: number;           // default 2000
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

export interface Department {
  name: string;
  keywords: string[];
  examples: string[];
}

export interface PriorityRules {
  critical: string[];   // descriptions/examples of what counts as critical
  high: string[];
  low: string[];
}

// ---------- store (src/store) ----------

export interface MessageQuery {
  chatIds?: string[];
  since?: number;        // inclusive
  until?: number;        // inclusive
  limit: number;
  order?: 'asc' | 'desc'; // default 'asc'
}

export interface ChatMessages {
  chat: Pick<Chat, 'id' | 'name' | 'type'>;
  messages: StoredMessage[];
}

export interface NewMessagesResult {
  chats: ChatMessages[];
  truncated: boolean;     // true if limit cut results
}

export interface SearchHit {
  message: StoredMessage;
  chatName: string | null;
  snippet: string;
}

export interface ListChatsQuery {
  type?: ChatType;
  activeSince?: number;
  includedOnly?: boolean;
}

export interface ChatSummary extends Chat {
  unreviewed: number;     // messages after reviewed_until (not from me)
}

export interface ItemQuery {
  status?: ItemStatus;
  department?: string;
  priority?: ItemPriority;
  limit?: number;
}

export interface StoreCounts {
  chatsIncluded: number;
  chatsTotal: number;
  messages: number;
  openItems: number;
}

export interface Store {
  /** Creates/updates schema. Idempotent. */
  migrate(): void;

  getAccount(): Account | null;
  upsertAccount(patch: Partial<Account> & { id: string }): void;
  setLinkStatus(status: Account['linkStatus'], at?: number): void;

  upsertChat(chat: Partial<Chat> & { id: string; type: ChatType }): void;
  getChat(id: string): Chat | null;
  listChats(q?: ListChatsQuery): ChatSummary[];
  setChatIncluded(id: string, included: boolean): void;
  replaceParticipants(chatId: string, participants: Omit<Participant, 'chatId'>[]): void;
  getParticipants(chatId: string): Participant[];

  /** Inserts; ignores duplicates (same chatId+id). Returns true if inserted. Updates chat.last_message_at. */
  insertMessage(msg: MessageInput): boolean;
  applyEdit(chatId: string, messageId: string, newText: string): boolean;
  markDeleted(chatId: string, messageId: string): boolean;
  getMessage(chatId: string, messageId: string): StoredMessage | null;

  getMessages(q: MessageQuery): StoredMessage[];
  /** since = 'last_review' uses each chat's reviewed_until (0 if never). Only included chats. */
  getNewMessages(q: { since: number | 'last_review'; chatIds?: string[]; limit: number }): NewMessagesResult;
  /** query is user text; implementation must escape it for FTS5 (never throw on odd input). */
  searchMessages(query: string, q: { chatIds?: string[]; since?: number; limit: number }): SearchHit[];
  getMentions(q: { since: number | 'last_review'; limit: number }): (StoredMessage & { mentionReason: MentionReason })[];

  setReviewed(chatIds: string[] | undefined, until: number): number;
  getReviewedUntil(chatId: string): number;

  /** Deletes messages with ts < cutoff. Returns deleted count. */
  purgeOlderThan(cutoff: number): number;

  saveItems(items: ItemInput[]): { saved: number; duplicates: number; ids: number[] };
  listItems(q?: ItemQuery): (Item & { chatName: string | null; sourcePurged: boolean })[];
  updateItem(id: number, status: ItemStatus): Item | null;

  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  counts(): StoreCounts;
  close(): void;
}

// ---------- daemon <-> WhatsApp facade (src/daemon/wa) ----------

export type ConnectionState =
  | { state: 'connecting' }
  | { state: 'qr'; qr: string }
  | { state: 'open'; me: { id: string; lid: string | null; pushName: string | null } }
  /** Offline messages delivered (Baileys receivedPendingNotifications). Emitted once per connection, after open. */
  | { state: 'caught_up' }
  | { state: 'close'; reason: 'logged_out' | 'restart_required' | 'connection_lost' | 'replaced' | 'bad_session' | 'forbidden' | 'unknown'; retry: boolean };

/** Raw message content after normalization, before mention detection. */
export type RawMessage = Omit<MessageInput, 'mentionReason'>;

export interface ChatMeta {
  id: string;
  type: ChatType;
  name: string | null;
  muted?: boolean;
  archived?: boolean;
}

export interface GroupMeta {
  id: string;
  subject: string | null;
  participants: { id: string; displayName: string | null; isAdmin: boolean }[];
}

export interface WaClientEvents {
  connection: (s: ConnectionState) => void;
  messages: (msgs: RawMessage[]) => void;
  edit: (e: { chatId: string; messageId: string; newText: string }) => void;
  delete: (e: { chatId: string; messageId: string }) => void;
  chats: (chats: ChatMeta[]) => void;
  groups: (groups: GroupMeta[]) => void;
  contacts: (contacts: { id: string; name: string | null }[]) => void;
}

/**
 * The ONLY object the rest of the code sees. It exposes no way to send anything to WhatsApp.
 * The single write-type action is unlink(), which calls logout() (approved exception, docs/DECISIONS.md).
 */
export interface WaClient {
  on<E extends keyof WaClientEvents>(event: E, listener: WaClientEvents[E]): void;
  /** Opens one connection. Reconnection policy is the caller's job (see backoff). */
  connect(): Promise<void>;
  /** Closes the socket without logging out. */
  close(): Promise<void>;
  /** Logs out the linked device on WhatsApp. Only called by `wa-bridge unlink`. */
  unlink(): Promise<void>;
}

// ---------- onboarding chat picker (T11) ----------

/** One row in the chat picker. Shared by the daemon (link) and the CLI picker. */
export interface ChatRow {
  id: string;
  name: string | null;
  type: ChatType;
  participantCount: number | null;
  lastMessageAt: number | null;
  preselected: boolean;
}
