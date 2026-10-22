// The ONLY module that talks to Baileys. Exposes a read-only, event-emitter facade (WaClient).
// The socket lives in a closure and is never returned or exposed.
import { EventEmitter } from 'node:events';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, proto } from 'baileys';
import type { BaileysEventMap, Chat, Contact, GroupMetadata, WAMessage, WAMessageKey, WAVersion } from 'baileys';
import type { Logger } from 'pino';
import type {
  ChatMeta, ConnectionState, GroupMeta, RawMessage, WaClient, WaClientEvents,
} from '../../core/contracts.js';
import type { useDbAuthState } from './auth-state.js';
import { extractDelete, extractEdit, normalizeMessage, toNumber } from './normalize.js';

type AuthHandle = Awaited<ReturnType<typeof useDbAuthState>>;
type Sock = ReturnType<typeof makeWASocket>;
type CloseReason = Extract<ConnectionState, { state: 'close' }>['reason'];

/** Mandatory read-only socket options. Tests assert on this object. */
export const READ_ONLY_SOCKET_CONFIG = {
  markOnlineOnConnect: false,
  syncFullHistory: false,
  fireInitQueries: true,
  emitOwnEvents: false,
  generateHighQualityLinkPreview: false,
  /** Same as the Baileys default: everything except the FULL history sync. */
  shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification): boolean =>
    msg.syncType !== proto.HistorySync.HistorySyncType.FULL,
} as const;

export function defaultBrowser(platform: string = process.platform): [string, string, string] {
  if (platform === 'win32') return Browsers.windows('Desktop');
  if (platform === 'darwin') return Browsers.macOS('Desktop');
  return Browsers.ubuntu('Desktop');
}

export interface CreateWaClientOptions {
  auth: AuthHandle;
  logger: Logger;
  browser?: [string, string, string];
  socketFactory?: typeof makeWASocket;
  getMessage?: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  /** Test hook. Default: Baileys' fetchLatestBaileysVersion (one network call per client, cached). */
  fetchVersion?: () => Promise<{ version: WAVersion; error?: unknown }>;
}

export function mapDisconnectReason(statusCode: number | undefined): CloseReason {
  switch (statusCode) {
    case DisconnectReason.loggedOut: return 'logged_out';
    case DisconnectReason.restartRequired: return 'restart_required';
    case DisconnectReason.connectionReplaced: return 'replaced';
    case DisconnectReason.badSession: return 'bad_session';
    case DisconnectReason.forbidden: return 'forbidden';
    case DisconnectReason.connectionLost: // same numeric value as timedOut
    case DisconnectReason.connectionClosed: return 'connection_lost';
    default: return 'unknown';
  }
}

const NO_RETRY: CloseReason[] = ['logged_out', 'forbidden', 'replaced'];

function chatTypeOf(id: string): 'group' | 'direct' | null {
  if (id.endsWith('@g.us')) return 'group';
  if (id.endsWith('@s.whatsapp.net') || id.endsWith('@lid')) return 'direct';
  return null; // broadcasts, newsletters, status
}

function toChatMeta(c: Partial<Chat>): ChatMeta | null {
  if (!c.id) return null;
  const type = chatTypeOf(c.id);
  if (!type) return null;
  const meta: ChatMeta = { id: c.id, type, name: c.name ?? c.displayName ?? null };
  if (c.archived !== undefined) meta.archived = !!c.archived;
  if (c.muteEndTime !== undefined) {
    let end = toNumber(c.muteEndTime);
    if (end > 1e11) end = Math.floor(end / 1000); // some sources give milliseconds
    meta.muted = end === -1 || end > Math.floor(Date.now() / 1000);
  }
  return meta;
}

function toGroupMeta(g: GroupMetadata): GroupMeta {
  return {
    id: g.id,
    subject: g.subject ?? null,
    participants: (g.participants ?? []).map((p) => ({
      id: p.phoneNumber ?? p.id,
      displayName: p.name ?? p.notify ?? null,
      isAdmin: !!p.isAdmin || !!p.isSuperAdmin || p.admin === 'admin' || p.admin === 'superadmin',
    })),
  };
}

function toContact(c: Partial<Contact>): { id: string; name: string | null } | null {
  if (!c.id) return null;
  const name = c.name ?? c.notify ?? c.verifiedName ?? null;
  if (name === null) return null;
  return { id: c.phoneNumber ?? c.id, name };
}

export function createWaClient(opts: CreateWaClientOptions): WaClient {
  const { auth, logger } = opts;
  const factory = opts.socketFactory ?? makeWASocket;
  const emitter = new EventEmitter();
  let sock: Sock | null = null;
  let generation = 0;
  let cachedVersion: WAVersion | undefined;
  let versionFetched = false;
  let meId = '';

  const emit = <E extends keyof WaClientEvents>(event: E, ...args: Parameters<WaClientEvents[E]>): void => {
    try {
      emitter.emit(event, ...args);
    } catch (err) {
      logger.error({ event, err: err instanceof Error ? err.message : 'unknown' }, 'wa listener threw');
    }
  };

  async function resolveVersion(): Promise<WAVersion | undefined> {
    if (versionFetched) return cachedVersion;
    versionFetched = true;
    try {
      const r = await (opts.fetchVersion ?? (() => fetchLatestBaileysVersion()))();
      if (!r.error) cachedVersion = r.version;
      else logger.warn('could not fetch latest WA version; using Baileys default');
    } catch {
      logger.warn('could not fetch latest WA version; using Baileys default');
    }
    return cachedVersion;
  }

  function normalizeAll(msgs: WAMessage[], type: string): void {
    const out: RawMessage[] = [];
    for (const m of msgs) {
      const del = extractDelete(m);
      if (del) { emit('delete', del); continue; }
      const edit = extractEdit(m);
      if (edit) { emit('edit', edit); continue; }
      const n = normalizeMessage(m, meId);
      if (n) out.push(n);
    }
    logger.debug({ type, in: msgs.length, out: out.length }, 'wa messages');
    if (out.length) emit('messages', out);
  }

  // Serialised, de-duplicated group metadata re-fetch (a read query, same as WhatsApp Web).
  const pendingGroups = new Set<string>();
  let fetchChain: Promise<void> = Promise.resolve();
  function refetchGroup(current: Sock, gen: number, id: string): void {
    if (pendingGroups.has(id)) return;
    pendingGroups.add(id);
    fetchChain = fetchChain.then(async () => {
      pendingGroups.delete(id);
      if (gen !== generation) return;
      try {
        const md = await current.groupMetadata(id);
        if (gen === generation) emit('groups', [toGroupMeta(md)]);
      } catch (err) {
        logger.warn({ id, err: err instanceof Error ? err.message : 'unknown' }, 'group metadata fetch failed');
      }
    });
  }

  async function fetchAllGroups(current: Sock, gen: number): Promise<void> {
    try {
      const all = await current.groupFetchAllParticipating();
      if (gen !== generation) return;
      const list = Object.values(all).map(toGroupMeta);
      if (list.length) emit('groups', list);
      const chats = list.map((g): ChatMeta => ({ id: g.id, type: 'group', name: g.subject }));
      if (chats.length) emit('chats', chats);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'group list fetch failed');
    }
  }

  function wire(current: Sock, gen: number): void {
    const live = (): boolean => gen === generation;
    const ev = current.ev;
    let groupsFetched = false;
    let caughtUpEmitted = false;

    ev.on('connection.update', (u: BaileysEventMap['connection.update']) => {
      if (!live()) return;
      if (u.qr) emit('connection', { state: 'qr', qr: u.qr });
      if (u.receivedPendingNotifications === true && !caughtUpEmitted) {
        caughtUpEmitted = true;
        emit('connection', { state: 'caught_up' });
      }
      if (u.connection === 'connecting') emit('connection', { state: 'connecting' });
      if (u.connection === 'open') {
        const user = current.user;
        meId = user?.id ? jidNormalizedUser(user.id) : meId;
        emit('connection', {
          state: 'open',
          me: { id: meId, lid: user?.lid ? jidNormalizedUser(user.lid) : null, pushName: user?.name ?? null },
        });
        if (!groupsFetched) {
          groupsFetched = true;
          void fetchAllGroups(current, gen);
        }
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const reason = mapDisconnectReason(code);
        logger.info({ reason, code }, 'wa connection closed');
        emit('connection', { state: 'close', reason, retry: !NO_RETRY.includes(reason) });
      }
    });

    ev.on('creds.update', () => {
      void auth.saveCreds().catch((err: unknown) => {
        logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'saveCreds failed');
      });
    });

    ev.on('messages.upsert', (u: BaileysEventMap['messages.upsert']) => {
      if (!live()) return;
      if (u.type !== 'notify' && u.type !== 'append') return;
      normalizeAll(u.messages, u.type);
    });

    ev.on('messages.update', (updates: BaileysEventMap['messages.update']) => {
      if (!live()) return;
      for (const { key, update } of updates) {
        if (!key.remoteJid || !key.id) continue;
        if (update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
          emit('delete', { chatId: key.remoteJid, messageId: key.id });
          continue;
        }
        if (update.message) {
          const edit = extractEdit({ key, message: update.message } as WAMessage);
          if (edit) emit('edit', edit);
        }
      }
    });

    const onChats = (list: Partial<Chat>[]): void => {
      if (!live()) return;
      const metas = list.map(toChatMeta).filter((c): c is ChatMeta => c !== null);
      if (metas.length) emit('chats', metas);
    };
    ev.on('chats.upsert', onChats);
    ev.on('chats.update', onChats);

    ev.on('groups.upsert', (list: BaileysEventMap['groups.upsert']) => {
      if (!live()) return;
      if (list.length) emit('groups', list.map(toGroupMeta));
    });
    ev.on('groups.update', (list: BaileysEventMap['groups.update']) => {
      if (!live()) return;
      for (const g of list) if (g.id) refetchGroup(current, gen, g.id);
    });
    ev.on('group-participants.update', (u: BaileysEventMap['group-participants.update']) => {
      if (!live()) return;
      refetchGroup(current, gen, u.id);
    });

    const onContacts = (list: Partial<Contact>[]): void => {
      if (!live()) return;
      const cs = list.map(toContact).filter((c): c is { id: string; name: string | null } => c !== null);
      if (cs.length) emit('contacts', cs);
    };
    ev.on('contacts.upsert', onContacts);
    ev.on('contacts.update', onContacts);

    ev.on('messaging-history.set', (h: BaileysEventMap['messaging-history.set']) => {
      if (!live()) return;
      onChats(h.chats);
      onContacts(h.contacts);
      normalizeAll(h.messages, 'history');
    });
  }

  return {
    on(event, listener) {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },

    async connect() {
      if (sock) {
        const old = sock;
        generation++;
        sock = null;
        void old.end(undefined);
      }
      const gen = ++generation;
      meId = auth.state.creds.me?.id ? jidNormalizedUser(auth.state.creds.me.id) : '';
      const version = await resolveVersion();
      const created = factory({
        ...READ_ONLY_SOCKET_CONFIG,
        auth: auth.state,
        // Baileys debug/trace logs can contain raw frames; cap at warn so message content never reaches the log.
        logger: logger.child({ class: 'baileys' }, { level: 'warn' }),
        browser: opts.browser ?? defaultBrowser(),
        getMessage: opts.getMessage ?? (async () => undefined),
        ...(version ? { version } : {}),
      });
      sock = created;
      wire(created, gen);
      logger.info('wa socket created');
    },

    async close() {
      const current = sock;
      generation++;
      sock = null;
      if (current) await current.end(undefined);
    },

    async unlink() {
      const current = sock;
      if (!current) throw new Error('unlink requires a connected client; call connect() and wait for open first');
      await current.logout();
      generation++;
      sock = null;
      auth.clear();
    },
  };
}
