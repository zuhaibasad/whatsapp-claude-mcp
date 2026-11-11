// The lock holder's brain: databases, collector and the setup state machine (SetupOps).
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { addToAllowlist, buildChatRows, computeRules, writeSelection, type ChatChoice } from '../config/selection.js';
import { loadConfig } from '../config/index.js';
import type { ChatRow, MasterKeyStore } from '../core/contracts.js';
import type { Logger } from '../core/logger.js';
import type { DataPaths } from '../core/paths.js';
import type { CollectorState, Diagnosis, SelectionSummary, SendDirectResult, SetupScreen, SetupState, SetupStep } from '../core/service.js';
import { runLinkSession } from '../daemon/link.js';
import { openDaemonDbs, startCollector, type CollectorHandle, type OpenedDbs } from '../daemon/runner.js';
import { OneTimeStore } from './auth.js';
import { backupBeforeMigration } from './backup.js';
import { buildDiagnosis } from './diagnose.js';
import { initDataFiles } from './init.js';
import { BROWSER_TOKEN_TTL_MS, HostError, NONCE_TTL_MS, type HostDeps, type HostOps } from './types.js';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const FIRST_QR_S = 60;
const NEXT_QR_S = 20;
const DIRECT_JID = /^[\w.:-]+@(s\.whatsapp\.net|lid)$/;
const SEND_MAX_CHARS = 1000;
const SEND_MIN_GAP_MS = 20_000;
const SEND_DAILY_LIMIT = 30;
const SEND_CONFIRM_TIMEOUT_MS = 90_000;
const SEND_COUNT_META = 'direct_sent_today';

export class HolderCore implements HostOps {
  readonly nonces: OneTimeStore;
  readonly browserTokens: OneTimeStore;
  readonly disconnectNonces: OneTimeStore;

  private keyStore: MasterKeyStore;
  private dbs: OpenedDbs | null = null;
  private collector: CollectorHandle | null = null;
  private collectorSeen: CollectorState = 'not_linked';
  private initError: string | null = null;
  private notice: string | null = null; // non-fatal message for the UI (e.g. offline disconnect)
  private disconnecting = false;
  private sending = false;
  private lastSentAt = 0;
  private port = 0;

  // flow state (null = at rest, the step is derived from the stores)
  private flow: SetupStep | null = null;
  private flowError: string | null = null;
  private qrSvg: string | null = null;
  private qrExpiresAt = 0;
  private qrCount = 0;
  private account: { id: string; pushName: string | null } | null = null;
  private sync: { chats: number; messages: number } | null = null;
  private linkPromise: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private pick: { resolve(v: Set<string> | null): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private stopping = false;
  private waiters = new Set<() => void>();

  constructor(
    private readonly paths: DataPaths,
    private readonly deps: HostDeps,
    private readonly logger: Logger,
  ) {
    this.keyStore = deps.keyStore(paths.projectRoot);
    this.nonces = new OneTimeStore(deps.now);
    this.browserTokens = new OneTimeStore(deps.now);
    this.disconnectNonces = new OneTimeStore(deps.now);
  }

  setPort(port: number): void {
    this.port = port;
  }

  /** Opens the databases if the install exists and starts the collector if the account is linked. */
  async start(): Promise<void> {
    try {
      if (fs.existsSync(this.paths.storeDb) && this.keyStore.get()) {
        await this.openDbs();
        this.startCollectorIfLinked();
      }
    } catch (err) {
      this.initError = msg(err);
      this.logger.error({ err: this.initError }, 'host start failed');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    if (this.pick) {
      clearTimeout(this.pick.timer);
      this.pick.resolve(null);
      this.pick = null;
    }
    try { await this.linkPromise; } catch { /* reported through state */ }
    await this.stopCollector();
    this.dbs?.close();
    this.dbs = null;
    this.notify();
  }

  collectorState(): CollectorState {
    return this.collector ? this.collector.state() : this.collectorSeen;
  }

  // ---------- SetupOps ----------

  async state(): Promise<SetupState> {
    const step = this.step();
    return {
      step,
      qrSvg: step === 'linking' ? this.qrSvg : null,
      qrExpiresIn: step === 'linking' && this.qrSvg ? Math.max(0, Math.ceil((this.qrExpiresAt - this.deps.now()) / 1000)) : null,
      account: this.account ?? this.storedAccount(),
      sync: this.sync,
      collector: this.collectorState(),
      error: step === 'error' ? (this.flowError ?? this.initError) : this.notice,
      version: this.deps.version,
    };
  }

  async acceptRisk(nonce?: string): Promise<SetupState> {
    if (!this.nonces.consume(nonce)) throw new HostError(403, 'accepting the risk needs the setup panel or a browser session');
    return this.acceptVerified();
  }

  /** Called by the HTTP layer after it verified a browser session or a nonce. */
  async acceptVerified(): Promise<SetupState> {
    if (this.flow === null && this.step() !== 'needs_accept') return this.state();
    this.notice = null;
    if (this.dbs) {
      this.dbs.store.setMeta('risk_accepted_at', String(Math.floor(this.deps.now() / 1000)));
    } else {
      await initDataFiles(this.paths, this.keyStore, { riskAcceptedAtMs: this.deps.now() });
      this.initError = null;
      await this.openDbs();
    }
    this.logger.info('risk accepted');
    return this.state();
  }

  async startLink(): Promise<SetupState> {
    if (this.flow === 'linking' || this.flow === 'syncing' || this.flow === 'choose_chats') return this.state();
    const rest = this.restStep();
    if (rest === 'needs_accept') throw new HostError(409, 'the risk warning has not been accepted yet');
    if (rest === 'done' && this.collector) throw new HostError(409, 'already linked');
    this.notice = null;
    await initDataFiles(this.paths, this.keyStore);
    if (!this.dbs) await this.openDbs();
    const dbs = this.requireDbs();
    await this.stopCollector();
    if (dbs.auth.hasCreds()) dbs.auth.clear(); // stale creds of a logged-out session
    this.flow = 'linking';
    this.flowError = null;
    this.qrSvg = null;
    this.qrCount = 0;
    this.account = null;
    this.sync = null;
    this.collectorSeen = 'not_linked';
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.linkPromise = this.runLink(dbs, signal).finally(() => {
      this.linkPromise = null;
      this.abort = null;
      this.notify();
    });
    this.notify();
    return this.state();
  }

  async cancelLink(): Promise<SetupState> {
    if (this.flow === 'linking') this.abort?.abort();
    else if (this.flow === 'choose_chats') this.resolvePick(null);
    else if (this.flow === 'error') {
      this.flow = null;
      this.flowError = null;
    }
    if (this.linkPromise) await this.linkPromise;
    return this.state();
  }

  async chatRows(): Promise<ChatRow[]> {
    const step = this.step();
    if (step !== 'choose_chats' && step !== 'done') throw new HostError(409, 'chats are not available yet');
    const dbs = this.requireDbs();
    return buildChatRows(dbs.store, loadConfig(this.paths).config);
  }

  async submitSelection(selectedIds: string[] | null): Promise<SelectionSummary | null> {
    const step = this.step();
    if (step === 'choose_chats') {
      this.resolvePick(selectedIds ? new Set(selectedIds) : null);
      if (this.linkPromise) await this.linkPromise;
      if (this.step() === 'error') throw new HostError(500, this.flowError ?? 'saving the selection failed');
      return this.summary();
    }
    if (step !== 'done') throw new HostError(409, 'there is no selection to save right now');
    if (selectedIds) {
      const dbs = this.requireDbs();
      const config = loadConfig(this.paths).config;
      const rows = buildChatRows(dbs.store, config);
      const all: ChatChoice[] = rows.map((r) => ({ id: r.id, name: r.name, type: r.type }));
      writeSelection(this.paths, computeRules(all, new Set(selectedIds), config), all);
      // The collector re-reads config.yaml within about 30 s and re-applies the filter.
    }
    return this.summary();
  }

  async waitForSync(timeoutMs: number): Promise<{ collector: CollectorState; waitedMs: number }> {
    const t0 = this.deps.now();
    const finished = (): boolean => {
      const s = this.collectorState();
      return s === 'live' || s === 'logged_out' || s === 'stopped' || (s === 'not_linked' && this.flow === null);
    };
    if (!finished()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(0, timeoutMs));
        const check = (): void => { if (finished()) done(); };
        function done(): void {
          clearTimeout(timer);
          w.delete(check);
          resolve();
        }
        const w = this.waiters;
        w.add(check);
      });
    }
    return { collector: this.collectorState(), waitedMs: this.deps.now() - t0 };
  }

  /** Needs a disconnect nonce (panel). The HTTP layer calls disconnectVerified after checking a session or nonce itself. */
  async disconnect(opts: { keepData: boolean; nonce?: string }): Promise<SetupState> {
    if (!this.disconnectNonces.consume(opts.nonce)) throw new HostError(403, 'disconnecting needs the setup panel or a browser session');
    return this.disconnectVerified({ keepData: opts.keepData });
  }

  /**
   * The only user-facing send. Every guard lives here, not in the tool text: allow_sending on, recipient = the author
   * of a stored message (never a group/channel, never yourself), text only and capped, rate limits, and a native OS
   * dialog the model cannot answer. Never logs the text.
   */
  async sendDirect(opts: { ref: string; text: string }): Promise<SendDirectResult> {
    const config = loadConfig(this.paths).config;
    if (!config.allowSending) {
      throw new HostError(403, 'sending is off: set allow_sending: true in config.yaml, then restart Claude');
    }
    const dbs = this.requireDbs();
    const collector = this.collector;
    if (!collector) throw new HostError(409, 'WhatsApp is not connected');
    const text = opts.text.trim();
    if (text === '') throw new HostError(400, 'the message text is empty');
    if (text.length > SEND_MAX_CHARS) throw new HostError(400, `the message is longer than ${SEND_MAX_CHARS} characters`);

    const slash = opts.ref.indexOf('/');
    const m = slash > 0 ? dbs.store.getMessage(opts.ref.slice(0, slash), opts.ref.slice(slash + 1)) : null;
    if (!m) throw new HostError(404, `no stored message with ref ${opts.ref}: use the ref of a message from a read chat`);
    if (m.isFromMe) throw new HostError(400, 'that message is yours: pick a message the other person wrote');
    if (!DIRECT_JID.test(m.senderId)) throw new HostError(400, 'the author of that message cannot be messaged directly');
    const contact = dbs.store.getContact(m.senderId);
    const phoneJid = contact?.phoneJid ?? (m.senderId.endsWith('@s.whatsapp.net') ? m.senderId : null);
    const lid = contact?.lid ?? (m.senderId.endsWith('@lid') ? m.senderId : null);
    if (phoneJid && phoneJid === dbs.store.getAccount()?.id) throw new HostError(400, 'that is your own number');
    const jid = phoneJid ?? m.senderId;
    const name = contact?.savedName ?? m.senderName ?? contact?.pushName ?? contact?.verifiedName ?? null;
    const phone = phoneJid ? `+${phoneJid.split('@')[0]}` : null;
    const to = [name, phone].filter(Boolean).join(' ') || 'this contact (no phone number shared)';

    if (this.sending) throw new HostError(409, 'another message is waiting for confirmation');
    const now = this.deps.now();
    if (now - this.lastSentAt < SEND_MIN_GAP_MS) {
      throw new HostError(429, `wait ${Math.ceil((SEND_MIN_GAP_MS - (now - this.lastSentAt)) / 1000)} s before the next message`);
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const [d, n] = (dbs.store.getMeta(SEND_COUNT_META) ?? '').split(' ');
    const sentToday = d === day ? Number(n) || 0 : 0;
    if (sentToday >= SEND_DAILY_LIMIT) throw new HostError(429, `the daily limit of ${SEND_DAILY_LIMIT} messages is reached`);

    this.sending = true;
    try {
      const where = dbs.store.getChat(m.chatId)?.name;
      const ok = await this.deps.dialogs.confirm(
        'ChatAI: send this WhatsApp message?',
        `Claude wants to send a PRIVATE WhatsApp message from your number.\n\nTo: ${to}${where ? `\n(they posted in: ${where})` : ''}\n\nMessage:\n${text}\n\nSend it?`,
        { yes: 'Send', no: 'Cancel' },
        SEND_CONFIRM_TIMEOUT_MS,
      );
      if (ok === null) return { sent: false, to, reason: 'no_dialog' };
      if (!ok) return { sent: false, to, reason: 'cancelled' };
      await collector.sendDirectText(jid, text);
      this.lastSentAt = this.deps.now();
      dbs.store.setMeta(SEND_COUNT_META, `${day} ${sentToday + 1}`);
      this.logger.info({ to: jid, ok: true }, 'direct message sent');
      // Read the reply: include the 1-to-1 chat under each id WhatsApp may use for it.
      const chats: ChatChoice[] = [...new Set([phoneJid, lid].filter((x): x is string => !!x))].map((id) => ({ id, name, type: 'direct' }));
      let tracking = false;
      try {
        addToAllowlist(this.paths, chats, `messaged ${day}`);
        for (const c of chats) dbs.store.upsertChat({ id: c.id, type: 'direct', included: true, ...(name ? { name } : {}) });
        tracking = true;
      } catch (e) {
        this.logger.warn({ err: msg(e) }, 'could not add the messaged chat to the allowlist');
      }
      return { sent: true, to, reply_tracking: tracking };
    } finally {
      this.sending = false;
    }
  }

  async diagnose(): Promise<Diagnosis> {
    let keyPresent: boolean | null;
    try { keyPresent = this.keyStore.get() !== null; } catch { keyPresent = null; }
    let link: string | null = null;
    try { link = this.dbs?.store.getAccount()?.linkStatus ?? null; } catch { /* reported as unlinked */ }
    const store = this.dbs?.store;
    return buildDiagnosis({
      paths: this.paths,
      version: this.deps.version,
      now: this.deps.now,
      keyPresent,
      meta: store ? (k) => store.getMeta(k) : null,
      linkStatus: link,
      collector: this.collectorState(),
    });
  }

  /**
   * Stops the collector, logs the device out of WhatsApp (WaClient.unlink, the one approved logout path), wipes the
   * session and, unless keepData, everything else. The lock stays with this process.
   */
  async disconnectVerified(opts: { keepData: boolean }): Promise<SetupState> {
    if (this.disconnecting) return this.state();
    this.disconnecting = true;
    try {
      this.abort?.abort();
      this.resolvePick(null);
      try { await this.linkPromise; } catch { /* reported through state */ }
      this.flow = null;
      this.flowError = null;
      await this.stopCollector();

      let note: string | null = null;
      const dbs = this.dbs;
      if (dbs && dbs.auth.hasCreds()) {
        const client = this.deps.waClientFactory({ auth: dbs.auth, logger: this.logger });
        try {
          const opened = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), this.deps.disconnectTimeoutMs);
            client.on('connection', (s) => {
              if (s.state === 'open') { clearTimeout(timer); resolve(true); }
              else if (s.state === 'close') { clearTimeout(timer); resolve(false); }
            });
          });
          await client.connect();
          if (await opened) await client.unlink();
          else note = 'x';
        } catch {
          note = 'x';
        } finally {
          try { await client.close(); } catch { /* ignore */ }
        }
        if (note) note = 'Could not reach WhatsApp; remove the device on your phone: Settings → Linked devices';
      }

      if (opts.keepData && dbs) {
        try { dbs.store.setLinkStatus('unlinked'); } catch { /* cosmetic */ }
      }
      dbs?.close();
      this.dbs = null;
      const rm = (file: string): void => {
        for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
      };
      rm(this.paths.authDb);
      fs.rmSync(this.paths.qrPng, { force: true });
      this.account = null;
      this.sync = null;
      this.qrSvg = null;
      this.collectorSeen = 'not_linked';
      this.initError = null;
      if (opts.keepData) {
        await this.openDbs();
      } else {
        rm(this.paths.storeDb);
        for (const f of [this.paths.config, this.paths.departments, this.paths.priorities]) fs.rmSync(f, { force: true });
        fs.rmSync(this.paths.exportsDir, { recursive: true, force: true });
        fs.rmSync(path.join(this.paths.dataDir, 'backups'), { recursive: true, force: true });
        this.keyStore.delete();
      }
      this.notice = note;
      this.logger.info({ keepData: opts.keepData, remote: note === null }, 'disconnected');
      this.notify();
      return this.state();
    } finally {
      this.disconnecting = false;
    }
  }

  // ---------- host-only ops ----------

  async mintNonce(kind: 'accept' | 'disconnect' = 'accept'): Promise<{ nonce: string }> {
    return { nonce: (kind === 'disconnect' ? this.disconnectNonces : this.nonces).mint(NONCE_TTL_MS) };
  }

  async openSetup(screen?: SetupScreen): Promise<{ opened: true }> {
    if (!this.port) throw new HostError(503, 'the control server is not listening yet');
    const token = this.browserTokens.mint(BROWSER_TOKEN_TTL_MS);
    this.deps.openUrl(`http://127.0.0.1:${this.port}/setup?t=${token}${screen === 'chats' || screen === 'disconnect' ? `&screen=${screen}` : ''}`);
    return { opened: true };
  }

  // ---------- internals ----------

  private notify(): void {
    for (const w of [...this.waiters]) w();
  }

  private requireDbs(): OpenedDbs {
    if (!this.dbs) throw new HostError(409, this.initError ?? 'not initialised');
    return this.dbs;
  }

  private async openDbs(): Promise<void> {
    const master = this.keyStore.get();
    if (!master) throw new Error('no encryption key found');
    // Encrypted copy of the databases before an older schema is upgraded (never blocks startup).
    backupBeforeMigration(this.paths.dataDir, master, {
      now: this.deps.now,
      onError: (e) => this.logger.warn({ err: msg(e) }, 'backup before migration failed'),
    });
    this.dbs = await openDaemonDbs(this.paths, master);
  }

  private storedAccount(): { id: string; pushName: string | null } | null {
    try {
      const a = this.dbs?.store.getAccount();
      return a ? { id: a.id, pushName: a.pushName } : null;
    } catch {
      return null;
    }
  }

  private restStep(): SetupStep {
    if (this.initError) return 'error';
    if (!this.dbs) return 'needs_accept';
    try {
      if (!this.dbs.store.getMeta('risk_accepted_at')) return 'needs_accept';
      const a = this.dbs.store.getAccount();
      if (this.dbs.auth.hasCreds() && a && a.linkStatus !== 'logged_out' && a.linkStatus !== 'unlinked') return 'done';
    } catch {
      return 'error';
    }
    return 'ready_to_link';
  }

  private step(): SetupStep {
    return this.flow ?? this.restStep();
  }

  private startCollectorIfLinked(): void {
    const dbs = this.dbs;
    if (!dbs || this.collector || this.stopping) return;
    const a = dbs.store.getAccount();
    if (!dbs.auth.hasCreds() || !a || a.linkStatus === 'logged_out' || a.linkStatus === 'unlinked') return;
    this.collectorSeen = 'connecting';
    const c = startCollector({
      paths: this.paths,
      dbs,
      logger: this.logger,
      waClientFactory: this.deps.waClientFactory,
      liveQuietMs: this.deps.liveQuietMs,
      liveMaxMs: this.deps.liveMaxMs,
      onState: (s) => { this.collectorSeen = s; this.notify(); },
    });
    this.collector = c;
    void c.done.then(() => {
      this.collectorSeen = c.state();
      if (this.collector === c) this.collector = null;
      this.notify();
    });
  }

  private async stopCollector(): Promise<void> {
    const c = this.collector;
    if (!c) return;
    await c.stop();
    this.collector = null;
    this.collectorSeen = 'stopped';
  }

  private resolvePick(v: Set<string> | null): void {
    const p = this.pick;
    if (!p) return;
    this.pick = null;
    clearTimeout(p.timer);
    p.resolve(v);
  }

  private async runLink(dbs: OpenedDbs, signal: AbortSignal): Promise<void> {
    try {
      await runLinkSession(dbs, this.paths, {
        timeoutMs: this.deps.linkTimeoutMs,
        settle: this.deps.settle,
        signal,
        logger: this.logger,
        waClientFactory: this.deps.waClientFactory,
        onQr: async (qr) => {
          const svg = await QRCode.toString(qr, { type: 'svg', margin: 1 });
          this.qrSvg = svg;
          this.qrExpiresAt = this.deps.now() + (this.qrCount++ === 0 ? FIRST_QR_S : NEXT_QR_S) * 1000;
        },
        onLinked: (a) => {
          this.account = a;
          this.qrSvg = null;
          this.sync = { chats: 0, messages: 0 };
          this.flow = 'syncing';
        },
        onProgress: (p) => { this.sync = p; },
        chooseChats: () => {
          this.flow = 'choose_chats';
          return new Promise<Set<string> | null>((resolve) => {
            const timer = setTimeout(() => this.resolvePick(null), this.deps.chooseTimeoutMs);
            this.pick = { resolve, timer };
          });
        },
      });
      this.flow = null;
      this.qrSvg = null;
      this.startCollectorIfLinked();
      this.logger.info('linked');
    } catch (err) {
      this.qrSvg = null;
      if (signal.aborted && !this.account) {
        this.flow = null;
        this.flowError = null;
      } else {
        this.flow = 'error';
        this.flowError = msg(err);
        this.logger.warn({ err: this.flowError }, 'link failed');
      }
    }
  }

  private summary(): SelectionSummary {
    const dbs = this.requireDbs();
    const config = loadConfig(this.paths).config;
    const rows = buildChatRows(dbs.store, config);
    const groups = rows.filter((r) => r.type === 'group');
    const direct = rows.filter((r) => r.type === 'direct');
    return {
      groupsSelected: groups.filter((r) => r.preselected).length,
      groupsTotal: groups.length,
      directSelected: direct.filter((r) => r.preselected).length,
      directTotal: direct.length,
      includeGroupsByDefault: config.includeGroups,
      includeDirectByDefault: config.includeDirectChats,
    };
  }
}
