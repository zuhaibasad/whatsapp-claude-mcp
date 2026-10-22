// Linking: shows QR codes via a callback until the user scans, then records the account.
import fs from 'node:fs';
import { loadConfig } from '../config/index.js';
import { buildChatRows, computeRules, writeSelection, type ChatChoice } from '../config/selection.js';
import type { ChatRow, Db, MasterKeyStore, RawMessage, WaClient } from '../core/contracts.js';
import { createLogger, type Logger } from '../core/logger.js';
import { resolvePaths, type DataPaths } from '../core/paths.js';
import { createMasterKeyStore } from '../crypto/index.js';
import { Ingestor } from './ingest.js';
import { DaemonAlreadyRunningError, acquireLock } from './lock.js';
import { NOT_INITIALIZED_MESSAGE, openDaemonDbs, type OpenedDbs, type WaClientFactoryArgs } from './runner.js';
import { createWaClient } from './wa/index.js';

export class AlreadyLinkedError extends Error {
  constructor() {
    super('already linked: run wa-bridge unlink first');
    this.name = 'AlreadyLinkedError';
  }
}

export interface LinkDeps {
  keyStore: (projectRoot: string) => MasterKeyStore;
  waClientFactory: (args: WaClientFactoryArgs) => WaClient;
  logger: Logger;
}

const MAX_RESTARTS = 3;

/** Most excluded-chat messages kept in memory while the user chooses chats. */
export const MAX_BUFFERED_MESSAGES = 50_000;

/**
 * Messages from chats the config excludes, held in memory only (never written to disk) until the user
 * has chosen which chats to read. When full, the oldest messages are dropped.
 */
export class ExcludedBuffer {
  private items: (RawMessage | undefined)[] = [];
  private head = 0;
  dropped = 0;

  constructor(private readonly cap: number = MAX_BUFFERED_MESSAGES) {}

  get size(): number {
    return this.items.length - this.head;
  }

  add(msg: RawMessage): void {
    this.items.push(msg);
    while (this.size > this.cap) {
      this.items[this.head++] = undefined;
      this.dropped++;
    }
    if (this.head > 10_000 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  /** Buffered messages grouped by chat, oldest first within each chat. */
  byChat(): Map<string, RawMessage[]> {
    const out = new Map<string, RawMessage[]>();
    for (let i = this.head; i < this.items.length; i++) {
      const m = this.items[i];
      if (!m) continue;
      const list = out.get(m.chatId);
      if (list) list.push(m);
      else out.set(m.chatId, [m]);
    }
    return out;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }
}

/** Deletes all stored messages of the given chats (the FTS triggers keep the search index in step). */
export function deleteMessagesOfChats(db: Db, chatIds: string[]): number {
  const del = db.prepare('DELETE FROM messages WHERE chat_id = ?');
  return db.transaction(() => {
    let n = 0;
    for (const id of chatIds) n += del.run(id).changes;
    return n;
  })();
}

/**
 * After the first open, stay connected while WhatsApp delivers the initial sync to the new device,
 * store it, and close once events go quiet. Closing right at open dropped that sync and cut off
 * Baileys' startup queries mid-flight.
 */
export interface SettleOptions {
  minMs: number;   // stay at least this long after open
  quietMs: number; // then close after this long without events
  maxMs: number;   // hard cap after open
}
export const DEFAULT_SETTLE: SettleOptions = { minMs: 10_000, quietMs: 15_000, maxMs: 120_000 };

export interface LinkSessionOptions {
  onQr(qr: string): Promise<void> | void;
  timeoutMs?: number;
  onStatus?(msg: string): void;
  /** Called once when the account is linked (before the initial sync settles). */
  onLinked?(account: { id: string; pushName: string | null }): void;
  /** Called with running counts while the initial sync arrives. */
  onProgress?(p: { chats: number; messages: number }): void;
  settle?: Partial<SettleOptions>;
  chooseChats?(rows: ChatRow[]): Promise<Set<string> | null>;
  bufferCap?: number;
  /** Aborting before the account is linked makes the session fail with "linking cancelled". */
  signal?: AbortSignal;
  logger: Logger;
  waClientFactory: (args: WaClientFactoryArgs) => WaClient;
}

/**
 * Runs one linking session on already-open databases. The caller owns the lock and the DBs.
 * Shows QR codes through onQr, waits for the initial sync, lets the user choose chats, then closes the client.
 */
export async function runLinkSession(
  dbs: Pick<OpenedDbs, 'store' | 'storeDb' | 'auth'>,
  paths: DataPaths,
  opts: LinkSessionOptions,
): Promise<{ id: string; pushName: string | null }> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const settle: SettleOptions = { ...DEFAULT_SETTLE, ...opts.settle };
  const { logger, waClientFactory } = opts;
  let client: WaClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setInterval> | null = null;
  const buffer = new ExcludedBuffer(opts.bufferCap);
  let clientClosed = false;
  const closeClient = async (): Promise<void> => {
    if (clientClosed) return;
    clientClosed = true;
    try {
      await client?.close();
    } catch {
      // ignore
    }
  };
  try {
    const { store, auth } = dbs;
    let config = loadConfig(paths).config;
    let me: { id: string; lid: string | null } | null = null;
    const ingestor = new Ingestor(store, () => config, () => (me ? { ...me, names: config.myNames } : null), logger);
    if (opts.chooseChats) ingestor.onExcluded = (m) => buffer.add(m);
    let lastEventAt = Date.now();
    const guarded = (what: string, fn: () => void): void => {
      lastEventAt = Date.now();
      try {
        fn();
      } catch (err) {
        logger.warn({ what, err: err instanceof Error ? err.message : String(err) }, 'ingest during link failed');
      }
    };

    const c = waClientFactory({ auth, logger });
    client = c;
    let msgCount = 0;
    const chatIds = new Set<string>();
    const progress = (): void => opts.onProgress?.({ chats: chatIds.size, messages: msgCount });
    c.on('messages', (m) => { msgCount += m.length; guarded('messages', () => ingestor.onMessages(m)); progress(); });
    c.on('edit', (e) => guarded('edit', () => ingestor.onEdit(e)));
    c.on('delete', (e) => guarded('delete', () => ingestor.onDelete(e)));
    c.on('chats', (x) => { for (const ch of x) chatIds.add(ch.id); guarded('chats', () => ingestor.onChats(x)); progress(); });
    c.on('groups', (g) => guarded('groups', () => ingestor.onGroups(g)));
    c.on('contacts', (x) => guarded('contacts', () => ingestor.onContacts(x)));
    c.on('lid-map', (m) => guarded('lid-map', () => ingestor.onLidMap(m)));
    c.on('activity', (a) => guarded('activity', () => ingestor.onActivity(a)));
    const result = await new Promise<{ id: string; pushName: string | null }>((resolve, reject) => {
      let settled = false;
      let restarts = 0;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      if (opts.signal) {
        const onAbort = (): void => { if (!me) fail(new Error('linking cancelled')); };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setTimeout(() => fail(new Error('linking timed out: no QR scan within the time limit')), timeoutMs);

      const connect = (): void => {
        c.connect().catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
      };

      c.on('connection', (s) => {
        if (settled) return;
        switch (s.state) {
          case 'qr':
            void Promise.resolve()
              .then(() => opts.onQr(s.qr))
              .catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
            return;
          case 'open': {
            if (me) return; // a later re-open while settling
            try {
              const nowS = Math.floor(Date.now() / 1000);
              store.upsertAccount({
                id: s.me.id,
                lid: s.me.lid,
                pushName: s.me.pushName,
                linkStatus: 'linked',
                linkedAt: nowS,
                lastConnectedAt: nowS,
              });
            } catch (err) {
              fail(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            me = { id: s.me.id, lid: s.me.lid };
            opts.onLinked?.({ id: s.me.id, pushName: s.me.pushName });
            config = loadConfig(paths).config;
            if (timer) clearTimeout(timer);
            opts.onStatus?.('Linked. Receiving the initial sync from your phone (up to 2 minutes)...');
            const openAt = Date.now();
            lastEventAt = openAt;
            const result = { id: s.me.id, pushName: s.me.pushName };
            settleTimer = setInterval(() => {
              const now = Date.now();
              const quiet = now - openAt >= settle.minMs && now - lastEventAt >= settle.quietMs;
              if (quiet || now - openAt >= settle.maxMs) {
                if (settleTimer) clearInterval(settleTimer);
                settled = true;
                try {
                  store.setMeta('last_sync_at', String(Math.floor(lastEventAt / 1000)));
                } catch {
                  // best effort
                }
                resolve(result);
              }
            }, Math.max(10, Math.min(1000, settle.quietMs || 10)));
            return;
          }
          case 'close':
            if (me) {
              // Already linked; the connection dropped while settling. Keep what we have.
              if (settleTimer) clearInterval(settleTimer);
              settled = true;
              resolve({ id: me.id, pushName: store.getAccount()?.pushName ?? null });
              return;
            }
            if (s.reason === 'restart_required') {
              // Normal right after scanning: the pairing flow needs a fresh connection.
              if (++restarts > MAX_RESTARTS) fail(new Error('linking failed: too many restarts'));
              else connect();
              return;
            }
            if (s.reason === 'logged_out') {
              try {
                auth.clear();
              } catch {
                // best effort
              }
              fail(new Error('linking failed: WhatsApp rejected the session (logged out)'));
              return;
            }
            fail(new Error(`linking failed: connection closed (${s.reason})`));
            return;
          default:
            return;
        }
      });
      connect();
    });
    if (opts.chooseChats) {
      await closeClient();
      ingestor.onExcluded = undefined;
      if (buffer.dropped > 0) {
        logger.warn({ dropped: buffer.dropped, kept: buffer.size }, 'excluded-chat buffer full; oldest messages dropped');
      }
      const rows = buildChatRows(store, config);
      const chosen = await opts.chooseChats(rows);
      if (chosen) {
        const all: ChatChoice[] = rows.map((r) => ({ id: r.id, name: r.name, type: r.type }));
        writeSelection(paths, computeRules(all, chosen, config), all);
        config = loadConfig(paths).config;
        ingestor.recomputeIncluded();
        const excludedNow = store.listChats({}).filter((c) => !c.included).map((c) => c.id);
        const removed = deleteMessagesOfChats(dbs.storeDb, excludedNow);
        const included = new Set(store.listChats({ includedOnly: true }).map((c) => c.id));
        const restored: RawMessage[] = [];
        for (const [chatId, msgs] of buffer.byChat()) if (included.has(chatId)) restored.push(...msgs);
        ingestor.onMessages(restored);
        logger.info({ removed, restored: restored.length }, 'chat choice applied');
      }
    }
    return result;
  } finally {
    buffer.clear();
    if (timer) clearTimeout(timer);
    if (settleTimer) clearInterval(settleTimer);
    await closeClient();
  }
}

export async function linkAccount(opts: {
  projectRoot: string;
  onQr(qr: string): Promise<void> | void;
  timeoutMs?: number;
  /** Progress lines for the user (e.g. "receiving initial sync"). */
  onStatus?(msg: string): void;
  settle?: Partial<SettleOptions>;
  /**
   * Lets the user pick which chats to read, after the initial sync and after the WhatsApp connection is closed.
   * Gets every known chat (also excluded ones); returns the chosen chat ids, or null to keep the config defaults.
   */
  chooseChats?(rows: ChatRow[]): Promise<Set<string> | null>;
  /** Test hook: cap for the in-memory buffer of excluded-chat messages. */
  bufferCap?: number;
  deps?: Partial<LinkDeps>;
}): Promise<{ id: string; pushName: string | null }> {
  const paths = resolvePaths(opts.projectRoot);
  const keyStore = (opts.deps?.keyStore ?? createMasterKeyStore)(paths.projectRoot);
  const waClientFactory =
    opts.deps?.waClientFactory ?? ((a: WaClientFactoryArgs) => createWaClient({ auth: a.auth, logger: a.logger }));

  fs.mkdirSync(paths.dataDir, { recursive: true });
  let lock: { release(): void } | null = null;
  let dbs: OpenedDbs | null = null;
  try {
    try {
      lock = acquireLock(paths.lockFile);
    } catch (err) {
      if (err instanceof DaemonAlreadyRunningError) {
        throw new Error(`the daemon is running (pid ${err.pid}): stop the daemon first`);
      }
      throw err;
    }
    const master = keyStore.get();
    if (!master) throw new Error(NOT_INITIALIZED_MESSAGE);
    const logger = opts.deps?.logger ?? createLogger({ level: 'warn', name: 'wa-bridge-link', file: paths.logFile });
    dbs = await openDaemonDbs(paths, master);
    const existing = dbs.store.getAccount();
    if (dbs.auth.hasCreds() && existing && existing.linkStatus !== 'logged_out' && existing.linkStatus !== 'unlinked') {
      throw new AlreadyLinkedError();
    }
    return await runLinkSession(dbs, paths, {
      onQr: opts.onQr,
      logger,
      waClientFactory,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
      ...(opts.settle ? { settle: opts.settle } : {}),
      ...(opts.chooseChats ? { chooseChats: opts.chooseChats } : {}),
      ...(opts.bufferCap !== undefined ? { bufferCap: opts.bufferCap } : {}),
    });
  } finally {
    dbs?.close();
    lock?.release();
    fs.rmSync(paths.qrPng, { force: true });
  }
}
