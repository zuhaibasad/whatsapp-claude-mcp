import type Database from 'better-sqlite3-multiple-ciphers';
import type {
  ChatMessages, Db, ItemQuery, ListChatsQuery, MessageQuery, NewMessagesResult,
  SearchHit, Store, StoreCounts, ChatSummary,
} from '../core/contracts.js';
import type {
  Account, Chat, ChatType, Contact, Item, ItemInput, ItemStatus, MentionReason, MessageExtra, MessageInput,
  MediaInfo, MediaRef, MediaStatus, OcrFields, Participant, StoredMessage,
} from '../core/types.js';
import { migrate } from './schema.js';

type Row = Record<string, unknown>;
type Param = string | number | bigint | Buffer | null;

const b = (v: unknown): boolean => Number(v) !== 0;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ---------- row <-> type mapping (single place) ----------

function toAccount(r: Row): Account {
  return {
    id: String(r.id), lid: s(r.lid), pushName: s(r.push_name),
    linkStatus: String(r.link_status) as Account['linkStatus'],
    linkedAt: n(r.linked_at), lastConnectedAt: n(r.last_connected_at), lastMessageAt: n(r.last_message_at),
  };
}

function toChat(r: Row): Chat {
  return {
    id: String(r.id), type: String(r.type) as ChatType, name: s(r.name),
    participantCount: n(r.participant_count), muted: b(r.muted), archived: b(r.archived),
    included: b(r.included), lastMessageAt: n(r.last_message_at),
    lastActivityAt: n(r.last_activity_at), unreadCount: n(r.unread_count),
  };
}

function toContact(r: Row): Contact {
  return {
    id: String(r.id), phoneJid: s(r.phone_jid), lid: s(r.lid), savedName: s(r.saved_name),
    pushName: s(r.push_name), verifiedName: s(r.verified_name), updatedAt: Number(r.updated_at ?? 0),
  };
}

/** Chat type from the JID suffix. */
export function chatTypeFromJid(id: string): ChatType {
  if (id.endsWith('@g.us')) return 'group';
  if (id.endsWith('@newsletter')) return 'channel';
  return 'direct';
}

function parseMentions(v: unknown): string[] {
  try {
    const p: unknown = JSON.parse(String(v ?? '[]'));
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}

function parseExtra(v: unknown): MessageExtra | null {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const o: unknown = JSON.parse(v);
    return o && typeof o === 'object' ? (o as MessageExtra) : null;
  } catch {
    return null;
  }
}

function toMessage(r: Row): StoredMessage {
  return {
    id: String(r.id), chatId: String(r.chat_id), senderId: String(r.sender_id), senderName: s(r.sender_name),
    ts: Number(r.ts), text: s(r.text), quotedId: s(r.quoted_id), quotedSenderId: s(r.quoted_sender_id),
    mentions: parseMentions(r.mentions), mentionReason: s(r.mention_reason) as MentionReason | null,
    isFromMe: b(r.is_from_me), hasMedia: b(r.has_media), mediaType: s(r.media_type),
    edited: b(r.edited), deleted: b(r.deleted),
    quotedText: s(r.quoted_text), quotedSenderName: s(r.quoted_sender_name), extra: parseExtra(r.extra),
  };
}

function toItem(r: Row): Item {
  return {
    id: Number(r.id), chatId: String(r.chat_id), messageId: String(r.message_id),
    category: String(r.category) as Item['category'], department: s(r.department),
    priority: String(r.priority) as Item['priority'], summary: String(r.summary), requester: s(r.requester),
    status: String(r.status) as ItemStatus, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

const MSG_COLS = 'm.id, m.chat_id, m.sender_id, m.sender_name, m.ts, m.text, m.quoted_id, m.quoted_sender_id, m.mentions, m.mention_reason, m.is_from_me, m.has_media, m.media_type, m.edited, m.deleted, m.quoted_text, m.quoted_sender_name, m.extra';

const MEDIA_COLS = 'md.chat_id, md.message_id, md.ts, md.kind, md.mimetype, md.status, md.size, (md.bytes IS NOT NULL) AS has_bytes, md.ocr_text, md.ocr_fields, md.ocr_confidence';

function toMediaInfo(r: Row): MediaInfo {
  let fields: OcrFields | null = null;
  if (typeof r.ocr_fields === 'string') {
    try { fields = JSON.parse(r.ocr_fields) as OcrFields; } catch { fields = null; }
  }
  return {
    chatId: String(r.chat_id), messageId: String(r.message_id), ts: Number(r.ts), kind: String(r.kind),
    mimetype: s(r.mimetype), status: String(r.status) as MediaStatus, size: n(r.size), hasBytes: b(r.has_bytes),
    ocrText: s(r.ocr_text), ocrFields: fields, ocrConfidence: n(r.ocr_confidence),
  };
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

/** Turns arbitrary user text into a safe FTS5 query: each token quoted, implicit AND. */
export function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(' ');
}

export class SqliteStore implements Store {
  private readonly cache = new Map<string, Database.Statement>();

  constructor(private readonly db: Db) {}

  private st(sql: string): Database.Statement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  private all(sql: string, ...p: Param[]): Row[] {
    return this.st(sql).all(...p) as Row[];
  }

  private one(sql: string, ...p: Param[]): Row | undefined {
    return this.st(sql).get(...p) as Row | undefined;
  }

  private run(sql: string, ...p: Param[]): number {
    return this.st(sql).run(...p).changes;
  }

  migrate(): void {
    migrate(this.db);
  }

  // ---------- account ----------

  getAccount(): Account | null {
    const r = this.one('SELECT * FROM accounts LIMIT 1');
    return r ? toAccount(r) : null;
  }

  upsertAccount(patch: Partial<Account> & { id: string }): void {
    const map: [keyof Account, string][] = [
      ['lid', 'lid'], ['pushName', 'push_name'], ['linkStatus', 'link_status'], ['linkedAt', 'linked_at'],
      ['lastConnectedAt', 'last_connected_at'], ['lastMessageAt', 'last_message_at'],
    ];
    const cols: string[] = [];
    const vals: Param[] = [];
    for (const [k, c] of map) {
      if (patch[k] !== undefined) {
        cols.push(c);
        vals.push(patch[k] as Param);
      }
    }
    this.db.transaction(() => {
      this.run('INSERT OR IGNORE INTO accounts(id) VALUES (?)', patch.id);
      if (cols.length > 0) {
        this.run(`UPDATE accounts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...vals, patch.id);
      }
    })();
  }

  setLinkStatus(status: Account['linkStatus'], at?: number): void {
    const acc = this.getAccount();
    if (!acc) return;
    this.run('UPDATE accounts SET link_status = ? WHERE id = ?', status, acc.id);
    if (status === 'linked' && at !== undefined) {
      this.run('UPDATE accounts SET linked_at = coalesce(linked_at, ?), last_connected_at = ? WHERE id = ?', at, at, acc.id);
    } else if (at !== undefined && status === 'connecting') {
      this.run('UPDATE accounts SET last_connected_at = ? WHERE id = ?', at, acc.id);
    }
  }

  // ---------- chats ----------

  upsertChat(chat: Partial<Chat> & { id: string; type: ChatType }): void {
    const map: [keyof Chat, string][] = [
      ['type', 'type'], ['name', 'name'], ['participantCount', 'participant_count'], ['muted', 'muted'],
      ['archived', 'archived'], ['included', 'included'], ['lastMessageAt', 'last_message_at'],
      ['lastActivityAt', 'last_activity_at'], ['unreadCount', 'unread_count'],
    ];
    const cols: string[] = [];
    const vals: Param[] = [];
    for (const [k, c] of map) {
      const v = chat[k];
      if (v !== undefined) {
        cols.push(c);
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param));
      }
    }
    this.db.transaction(() => {
      this.run('INSERT OR IGNORE INTO chats(id, type) VALUES (?, ?)', chat.id, chat.type);
      if (cols.length > 0) this.run(`UPDATE chats SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...vals, chat.id);
    })();
  }

  getChat(id: string): Chat | null {
    const r = this.one('SELECT * FROM chats WHERE id = ?', id);
    return r ? toChat(r) : null;
  }

  listChats(q: ListChatsQuery = {}): ChatSummary[] {
    const where: string[] = [];
    const p: Param[] = [];
    if (q.type) { where.push('c.type = ?'); p.push(q.type); }
    if (q.activeSince !== undefined) { where.push('c.last_message_at >= ?'); p.push(q.activeSince); }
    if (q.includedOnly) where.push('c.included = 1');
    const sql = `SELECT c.*, (SELECT count(*) FROM messages m WHERE m.chat_id = c.id AND m.is_from_me = 0
        AND m.ts > coalesce((SELECT u.reviewed_until FROM unread_state u WHERE u.chat_id = c.id), 0)) AS unreviewed
      FROM chats c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY max(coalesce(c.last_activity_at, 0), coalesce(c.last_message_at, 0)) DESC, c.id`;
    return this.all(sql, ...p).map((r) => ({ ...toChat(r), unreviewed: Number(r.unreviewed) }));
  }

  setChatIncluded(id: string, included: boolean): void {
    this.run('UPDATE chats SET included = ? WHERE id = ?', included ? 1 : 0, id);
  }

  upsertContact(c: Partial<Contact> & { id: string }): void {
    this.db.transaction(() => {
      const phoneJid = c.phoneJid ?? (c.id.endsWith('@s.whatsapp.net') ? c.id : null);
      const lid = c.lid ?? (c.id.endsWith('@lid') ? c.id : null);
      const keys = [...new Set([c.id, phoneJid, lid].filter((k): k is string => !!k))];
      const ph = placeholders(keys.length);
      const rows = this.all(
        `SELECT * FROM contacts WHERE id IN (${ph}) OR phone_jid IN (${ph}) OR lid IN (${ph})`, ...keys, ...keys, ...keys,
      );
      const target = rows.find((r) => r.id === c.id) ?? rows[0];
      const incoming = {
        phone_jid: phoneJid, lid, saved_name: c.savedName ?? null, push_name: c.pushName ?? null,
        verified_name: c.verifiedName ?? null,
      };
      const merged: Record<string, string | null> = { phone_jid: null, lid: null, saved_name: null, push_name: null, verified_name: null };
      // precedence: incoming non-null > target > other duplicate rows
      const ordered = [...(target ? [target] : []), ...rows.filter((r) => r !== target)];
      for (const col of Object.keys(merged)) {
        const inc = incoming[col as keyof typeof incoming];
        merged[col] = inc ?? ordered.map((r) => s(r[col])).find((v) => v !== null) ?? null;
      }
      const id = target ? String(target.id) : c.id;
      for (const r of rows) if (r !== target) this.run('DELETE FROM contacts WHERE id = ?', String(r.id));
      this.run(
        `INSERT INTO contacts(id, phone_jid, lid, saved_name, push_name, verified_name, updated_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET phone_jid = excluded.phone_jid, lid = excluded.lid, saved_name = excluded.saved_name,
           push_name = excluded.push_name, verified_name = excluded.verified_name, updated_at = excluded.updated_at`,
        id, merged.phone_jid ?? null, merged.lid ?? null, merged.saved_name ?? null, merged.push_name ?? null,
        merged.verified_name ?? null, c.updatedAt ?? Math.floor(Date.now() / 1000),
      );
    })();
  }

  getContact(idOrPhoneOrLid: string): Contact | null {
    const r = this.one('SELECT * FROM contacts WHERE id = ? OR phone_jid = ? OR lid = ? ORDER BY (id = ?) DESC LIMIT 1',
      idOrPhoneOrLid, idOrPhoneOrLid, idOrPhoneOrLid, idOrPhoneOrLid);
    return r ? toContact(r) : null;
  }

  linkLid(lid: string, phoneJid: string): void {
    this.upsertContact({ id: phoneJid, phoneJid, lid });
  }

  touchChatActivity(chatId: string, ts: number, unreadCount?: number | null, included = false): void {
    this.db.transaction(() => {
      this.run('INSERT OR IGNORE INTO chats(id, type, included) VALUES (?, ?, ?)', chatId, chatTypeFromJid(chatId), included ? 1 : 0);
      if (ts > 0) this.run('UPDATE chats SET last_activity_at = max(coalesce(last_activity_at, 0), ?) WHERE id = ?', ts, chatId);
      if (unreadCount !== undefined && unreadCount !== null) {
        this.run('UPDATE chats SET unread_count = ? WHERE id = ?', unreadCount, chatId);
      }
    })();
  }

  replaceParticipants(chatId: string, participants: Omit<Participant, 'chatId'>[]): void {
    this.db.transaction(() => {
      this.run('DELETE FROM participants WHERE chat_id = ?', chatId);
      for (const p of participants) {
        this.run('INSERT OR REPLACE INTO participants(chat_id, contact_id, display_name, is_admin) VALUES (?,?,?,?)',
          chatId, p.contactId, p.displayName, p.isAdmin ? 1 : 0);
      }
      this.run('UPDATE chats SET participant_count = ? WHERE id = ?', participants.length, chatId);
    })();
  }

  getParticipants(chatId: string): Participant[] {
    return this.all('SELECT * FROM participants WHERE chat_id = ? ORDER BY contact_id', chatId).map((r) => ({
      chatId: String(r.chat_id), contactId: String(r.contact_id), displayName: s(r.display_name), isAdmin: b(r.is_admin),
    }));
  }

  // ---------- messages ----------

  insertMessage(msg: MessageInput): boolean {
    return this.db.transaction((): boolean => {
      this.run('INSERT OR IGNORE INTO chats(id, type, included) VALUES (?, ?, 1)', msg.chatId, chatTypeFromJid(msg.chatId));
      const changes = this.run(
        `INSERT OR IGNORE INTO messages(id, chat_id, sender_id, sender_name, ts, text, quoted_id, quoted_sender_id,
           mentions, mention_reason, is_from_me, has_media, media_type, edited, deleted,
           quoted_text, quoted_sender_name, extra)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
        msg.id, msg.chatId, msg.senderId, msg.senderName, msg.ts, msg.text, msg.quotedId, msg.quotedSenderId,
        JSON.stringify(msg.mentions), msg.mentionReason, msg.isFromMe ? 1 : 0, msg.hasMedia ? 1 : 0, msg.mediaType,
        msg.quotedText ?? null, msg.quotedSenderName ?? null, msg.extra ? JSON.stringify(msg.extra) : null,
      );
      if (changes === 0) return false;
      const md = msg.media;
      if (md) {
        this.run(
          `INSERT OR IGNORE INTO media(chat_id, message_id, ts, kind, mimetype, file_length, media_key, direct_path, url)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          msg.chatId, msg.id, msg.ts, md.kind, md.mimetype, md.fileLength, md.mediaKey, md.directPath, md.url,
        );
      }
      this.run(`UPDATE chats SET last_message_at = max(coalesce(last_message_at, 0), ?),
        last_activity_at = max(coalesce(last_activity_at, 0), ?) WHERE id = ?`, msg.ts, msg.ts, msg.chatId);
      this.run('UPDATE accounts SET last_message_at = max(coalesce(last_message_at, 0), ?)', msg.ts);
      return true;
    })();
  }

  applyEdit(chatId: string, messageId: string, newText: string): boolean {
    return this.run('UPDATE messages SET text = ?, edited = 1 WHERE chat_id = ? AND id = ? AND deleted = 0',
      newText, chatId, messageId) > 0;
  }

  markDeleted(chatId: string, messageId: string): boolean {
    return this.run('UPDATE messages SET deleted = 1, text = NULL, quoted_text = NULL, extra = NULL WHERE chat_id = ? AND id = ?', chatId, messageId) > 0;
  }

  getMessage(chatId: string, messageId: string): StoredMessage | null {
    const r = this.one(`SELECT ${MSG_COLS} FROM messages m WHERE m.chat_id = ? AND m.id = ?`, chatId, messageId);
    return r ? toMessage(r) : null;
  }

  getMessagesBefore(chatId: string, beforeTs: number, n: number): StoredMessage[] {
    const rows = this.all(
      `SELECT ${MSG_COLS} FROM messages m WHERE m.chat_id = ? AND m.ts < ? AND m.deleted = 0
       ORDER BY m.ts DESC, m.rowid DESC LIMIT ?`, chatId, beforeTs, n);
    return rows.map(toMessage).reverse();
  }

  getMessages(q: MessageQuery): StoredMessage[] {
    const where: string[] = [];
    const p: Param[] = [];
    if (q.chatIds && q.chatIds.length > 0) {
      where.push(`m.chat_id IN (${placeholders(q.chatIds.length)})`);
      p.push(...q.chatIds);
    }
    if (q.since !== undefined) { where.push('m.ts >= ?'); p.push(q.since); }
    if (q.until !== undefined) { where.push('m.ts <= ?'); p.push(q.until); }
    const dir = q.order === 'desc' ? 'DESC' : 'ASC';
    const sql = `SELECT ${MSG_COLS} FROM messages m ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.ts ${dir}, m.rowid ${dir} LIMIT ?`;
    return this.all(sql, ...p, q.limit).map(toMessage);
  }

  /** Builds the since-filter + chat filter shared by getNewMessages / getMentions (included chats only). */
  private sinceClause(since: number | 'last_review', chatIds?: string[]): { sql: string; p: Param[] } {
    const parts: string[] = ['c.included = 1'];
    const p: Param[] = [];
    if (since === 'last_review') {
      parts.push('m.ts > coalesce((SELECT u.reviewed_until FROM unread_state u WHERE u.chat_id = m.chat_id), 0)');
    } else {
      parts.push('m.ts >= ?');
      p.push(since);
    }
    if (chatIds && chatIds.length > 0) {
      parts.push(`m.chat_id IN (${placeholders(chatIds.length)})`);
      p.push(...chatIds);
    }
    return { sql: parts.join(' AND '), p };
  }

  getNewMessages(q: { since: number | 'last_review'; chatIds?: string[]; limit: number }): NewMessagesResult {
    const { sql: w, p } = this.sinceClause(q.since, q.chatIds);
    const rows = this.all(
      `SELECT ${MSG_COLS}, c.name AS chat_name, c.type AS chat_type FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE ${w}
       ORDER BY coalesce(c.last_message_at, 0) DESC, c.id, m.ts ASC, m.rowid ASC LIMIT ?`,
      ...p, q.limit + 1,
    );
    const truncated = rows.length > q.limit;
    const chats: ChatMessages[] = [];
    let cur: ChatMessages | undefined;
    for (const r of rows.slice(0, q.limit)) {
      const id = String(r.chat_id);
      if (!cur || cur.chat.id !== id) {
        cur = { chat: { id, name: s(r.chat_name), type: String(r.chat_type) as ChatType }, messages: [] };
        chats.push(cur);
      }
      cur.messages.push(toMessage(r));
    }
    return { chats, truncated };
  }

  searchMessages(query: string, q: { chatIds?: string[]; since?: number; limit: number }): SearchHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const where: string[] = ['messages_fts MATCH ?', 'c.included = 1'];
    const p: Param[] = [fts];
    if (q.chatIds && q.chatIds.length > 0) {
      where.push(`m.chat_id IN (${placeholders(q.chatIds.length)})`);
      p.push(...q.chatIds);
    }
    if (q.since !== undefined) { where.push('m.ts >= ?'); p.push(q.since); }
    const sql = `SELECT ${MSG_COLS}, c.name AS chat_name, snippet(messages_fts, 0, '[', ']', '…', 12) AS snip
      FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN chats c ON c.id = m.chat_id
      WHERE ${where.join(' AND ')} ORDER BY bm25(messages_fts), m.ts DESC LIMIT ?`;
    // Same filters against the OCR text of images.
    const mediaSql = `SELECT ${MSG_COLS}, c.name AS chat_name, snippet(media_fts, 0, '[', ']', '…', 12) AS snip
      FROM media_fts JOIN media md ON md.rowid = media_fts.rowid
      JOIN messages m ON m.chat_id = md.chat_id AND m.id = md.message_id JOIN chats c ON c.id = m.chat_id
      WHERE ${where.join(' AND ').replace('messages_fts MATCH', 'media_fts MATCH')} ORDER BY bm25(media_fts), m.ts DESC LIMIT ?`;
    try {
      const hits: SearchHit[] = this.all(sql, ...p, q.limit).map((r) => ({
        message: toMessage(r), chatName: s(r.chat_name), snippet: String(r.snip ?? ''),
      }));
      const seen = new Set(hits.map((h) => `${h.message.chatId}/${h.message.id}`));
      for (const r of this.all(mediaSql, ...p, q.limit)) {
        if (hits.length >= q.limit) break;
        const m = toMessage(r);
        if (seen.has(`${m.chatId}/${m.id}`)) continue;
        hits.push({ message: m, chatName: s(r.chat_name), snippet: `[image text] ${String(r.snip ?? '')}` });
      }
      return hits;
    } catch {
      return []; // FTS5 syntax problem on exotic input: never throw
    }
  }

  // ---------- media ----------

  getMediaInfo(chatId: string, messageId: string): MediaInfo | null {
    const r = this.one(`SELECT ${MEDIA_COLS} FROM media md WHERE md.chat_id = ? AND md.message_id = ?`, chatId, messageId);
    return r ? toMediaInfo(r) : null;
  }

  getMediaBytes(chatId: string, messageId: string): { bytes: Buffer; mimetype: string | null } | null {
    const r = this.one('SELECT bytes, mimetype FROM media WHERE chat_id = ? AND message_id = ? AND bytes IS NOT NULL', chatId, messageId);
    return r ? { bytes: r.bytes as Buffer, mimetype: s(r.mimetype) } : null;
  }

  listMedia(q: { chatIds?: string[]; since?: number; until?: number; limit: number }): (MediaInfo & { chatName: string | null })[] {
    const where: string[] = ['c.included = 1'];
    const p: Param[] = [];
    if (q.chatIds && q.chatIds.length > 0) {
      where.push(`md.chat_id IN (${placeholders(q.chatIds.length)})`);
      p.push(...q.chatIds);
    }
    if (q.since !== undefined) { where.push('md.ts >= ?'); p.push(q.since); }
    if (q.until !== undefined) { where.push('md.ts <= ?'); p.push(q.until); }
    return this.all(
      `SELECT ${MEDIA_COLS}, c.name AS chat_name FROM media md JOIN chats c ON c.id = md.chat_id
       WHERE ${where.join(' AND ')} ORDER BY md.ts DESC LIMIT ?`,
      ...p, q.limit,
    ).map((r) => ({ ...toMediaInfo(r), chatName: s(r.chat_name) }));
  }

  nextPendingMedia(now: number, limit: number): (MediaRef & { chatId: string; messageId: string; attempts: number })[] {
    return this.all(
      `SELECT chat_id, message_id, kind, mimetype, file_length, media_key, direct_path, url, attempts FROM media
       WHERE status = 'pending' AND next_try_at <= ? ORDER BY ts DESC LIMIT ?`,
      now, limit,
    ).map((r) => ({
      chatId: String(r.chat_id), messageId: String(r.message_id), kind: 'image',
      mimetype: s(r.mimetype), fileLength: n(r.file_length), mediaKey: String(r.media_key ?? ''),
      directPath: s(r.direct_path), url: s(r.url), attempts: Number(r.attempts),
    }));
  }

  saveMediaResult(chatId: string, messageId: string, r: {
    status: MediaStatus; bytes?: Buffer | null; ocrText?: string | null; ocrFields?: OcrFields | null; ocrConfidence?: number | null;
  }): void {
    // The download keys are dropped once the media reached a final state.
    this.run(
      `UPDATE media SET status = ?, bytes = ?, size = ?, ocr_text = ?, ocr_fields = ?, ocr_confidence = ?,
         media_key = NULL, direct_path = NULL, url = NULL WHERE chat_id = ? AND message_id = ?`,
      r.status, r.bytes ?? null, r.bytes ? r.bytes.length : null, r.ocrText ?? null,
      r.ocrFields ? JSON.stringify(r.ocrFields) : null, r.ocrConfidence ?? null, chatId, messageId,
    );
  }

  markMediaRetry(chatId: string, messageId: string, nextTryAt: number, giveUp: boolean): void {
    this.run(
      `UPDATE media SET attempts = attempts + 1, next_try_at = ?, status = CASE WHEN ? THEN 'failed' ELSE status END
       WHERE chat_id = ? AND message_id = ?`,
      nextTryAt, giveUp ? 1 : 0, chatId, messageId,
    );
  }

  capMediaBytes(maxBytes: number): number {
    const total = Number(this.one('SELECT coalesce(sum(size), 0) AS t FROM media WHERE bytes IS NOT NULL')?.t ?? 0);
    if (total <= maxBytes) return 0;
    let over = total - maxBytes;
    let trimmed = 0;
    for (const r of this.all('SELECT rowid, size FROM media WHERE bytes IS NOT NULL ORDER BY ts ASC')) {
      if (over <= 0) break;
      this.run('UPDATE media SET bytes = NULL WHERE rowid = ?', Number(r.rowid));
      over -= Number(r.size ?? 0);
      trimmed++;
    }
    return trimmed;
  }

  getMentions(q: { since: number | 'last_review'; limit: number }): (StoredMessage & { mentionReason: MentionReason })[] {
    const { sql: w, p } = this.sinceClause(q.since);
    const rows = this.all(
      `SELECT ${MSG_COLS} FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.mention_reason IS NOT NULL AND ${w} ORDER BY m.ts ASC, m.rowid ASC LIMIT ?`,
      ...p, q.limit,
    );
    return rows.map((r) => toMessage(r) as StoredMessage & { mentionReason: MentionReason });
  }

  // ---------- review state ----------

  setReviewed(chatIds: string[] | undefined, until: number): number {
    return this.db.transaction((): number => {
      const ids = chatIds ?? this.all('SELECT id FROM chats WHERE included = 1').map((r) => String(r.id));
      let changed = 0;
      for (const id of ids) {
        changed += this.run(
          `INSERT INTO unread_state(chat_id, reviewed_until) SELECT id, ? FROM chats WHERE id = ?
           ON CONFLICT(chat_id) DO UPDATE SET reviewed_until = max(reviewed_until, excluded.reviewed_until)`,
          until, id,
        );
      }
      return changed;
    })();
  }

  getReviewedUntil(chatId: string): number {
    const r = this.one('SELECT reviewed_until FROM unread_state WHERE chat_id = ?', chatId);
    return r ? Number(r.reviewed_until) : 0;
  }

  purgeOlderThan(cutoff: number): number {
    this.run('DELETE FROM media WHERE ts < ?', cutoff);
    return this.run('DELETE FROM messages WHERE ts < ?', cutoff);
  }

  // ---------- items ----------

  saveItems(items: ItemInput[]): { saved: number; duplicates: number; ids: number[] } {
    return this.db.transaction(() => {
      const now = Math.floor(Date.now() / 1000);
      let saved = 0;
      let duplicates = 0;
      const ids: number[] = [];
      for (const it of items) {
        const res = this.st(
          `INSERT OR IGNORE INTO items(chat_id, message_id, category, department, priority, summary, requester, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?, 'open', ?, ?)`,
        ).run(it.chatId, it.messageId, it.category, it.department, it.priority, it.summary, it.requester, now, now);
        if (res.changes > 0) {
          saved++;
          ids.push(Number(res.lastInsertRowid));
        } else {
          duplicates++;
          const ex = this.one('SELECT id FROM items WHERE chat_id = ? AND message_id = ? AND category = ?',
            it.chatId, it.messageId, it.category);
          ids.push(Number(ex?.id));
        }
      }
      return { saved, duplicates, ids };
    })();
  }

  listItems(q: ItemQuery = {}): (Item & { chatName: string | null; sourcePurged: boolean })[] {
    const where: string[] = [];
    const p: Param[] = [];
    if (q.status) { where.push('i.status = ?'); p.push(q.status); }
    if (q.department) { where.push('i.department = ?'); p.push(q.department); }
    if (q.priority) { where.push('i.priority = ?'); p.push(q.priority); }
    const sql = `SELECT i.*, c.name AS chat_name,
        NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = i.chat_id AND m.id = i.message_id) AS source_purged
      FROM items i LEFT JOIN chats c ON c.id = i.chat_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY i.created_at ASC, i.id ASC ${q.limit !== undefined ? 'LIMIT ?' : ''}`;
    if (q.limit !== undefined) p.push(q.limit);
    return this.all(sql, ...p).map((r) => ({ ...toItem(r), chatName: s(r.chat_name), sourcePurged: b(r.source_purged) }));
  }

  updateItem(id: number, status: ItemStatus): Item | null {
    const now = Math.floor(Date.now() / 1000);
    if (this.run('UPDATE items SET status = ?, updated_at = ? WHERE id = ?', status, now, id) === 0) return null;
    const r = this.one('SELECT * FROM items WHERE id = ?', id);
    return r ? toItem(r) : null;
  }

  // ---------- meta / misc ----------

  getMeta(key: string): string | null {
    return s(this.one('SELECT value FROM meta WHERE key = ?', key)?.value);
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  counts(): StoreCounts {
    const num = (sql: string): number => Number(this.one(sql)?.c ?? 0);
    return {
      chatsIncluded: num('SELECT count(*) AS c FROM chats WHERE included = 1'),
      chatsTotal: num('SELECT count(*) AS c FROM chats'),
      messages: num('SELECT count(*) AS c FROM messages'),
      openItems: num("SELECT count(*) AS c FROM items WHERE status = 'open'"),
    };
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }
}
