// The lock holder's brain: databases, collector and the setup state machine (SetupOps).
import fs from 'node:fs';
import QRCode from 'qrcode';
import { buildChatRows, computeRules, writeSelection, type ChatChoice } from '../config/selection.js';
import { loadConfig } from '../config/index.js';
import type { ChatRow, MasterKeyStore } from '../core/contracts.js';
import type { Logger } from '../core/logger.js';
import type { DataPaths } from '../core/paths.js';
import type { CollectorState, SelectionSummary, SetupState, SetupStep } from '../core/service.js';
import { runLinkSession } from '../daemon/link.js';
import { openDaemonDbs, startCollector, type CollectorHandle, type OpenedDbs } from '../daemon/runner.js';
import { OneTimeStore } from './auth.js';
import { initDataFiles } from './init.js';
import { BROWSER_TOKEN_TTL_MS, HostError, NONCE_TTL_MS, type HostDeps, type HostOps } from './types.js';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const FIRST_QR_S = 60;
const NEXT_QR_S = 20;

export class HolderCore implements HostOps {
  readonly nonces: OneTimeStore;
  readonly browserTokens: OneTimeStore;

  private keyStore: MasterKeyStore;
  private dbs: OpenedDbs | null = null;
  private collector: CollectorHandle | null = null;
  private collectorSeen: CollectorState = 'not_linked';
  private initError: string | null = null;
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
      error: step === 'error' ? (this.flowError ?? this.initError) : null,
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

  // ---------- host-only ops ----------

  async mintNonce(): Promise<{ nonce: string }> {
    return { nonce: this.nonces.mint(NONCE_TTL_MS) };
  }

  async openSetup(): Promise<{ opened: true }> {
    if (!this.port) throw new HostError(503, 'the control server is not listening yet');
    const token = this.browserTokens.mint(BROWSER_TOKEN_TTL_MS);
    this.deps.openUrl(`http://127.0.0.1:${this.port}/setup?t=${token}`);
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
