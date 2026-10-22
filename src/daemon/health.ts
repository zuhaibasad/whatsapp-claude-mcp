// Connection health beyond Baileys' own transport watchdog: sleep/resume detection, app-level stall
// detection, health meta for diagnose, and proxy configuration. Pure logic with injected clocks.
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Agent } from 'node:https';

// ---------- meta keys (read by T20 diagnose) ----------

export const HEALTH_META = {
  lastFrameAt: 'health_last_frame_at',
  lastAppEventAt: 'health_last_app_event_at',
  reconnects24h: 'health_reconnects_24h',
  lastReason: 'health_last_reason',
  connectedAt: 'health_connected_at',
} as const;

export const HEALTH_WRITE_THROTTLE_MS = 10_000;
export const HEALTH_TICK_MS = 15_000;
export const SLEEP_JUMP_MS = 60_000;
export const DAY_MS = 86_400_000;
export const DEFAULT_KEEPALIVE_MS = 30_000;

export type HealthAction = 'sleep' | 'stall' | null;

export interface HealthClock {
  /** Wall clock in ms (Date.now). */
  wall(): number;
  /** Monotonic clock in ms (performance.now). */
  mono(): number;
}

export const systemClock: HealthClock = { wall: () => Date.now(), mono: () => performance.now() };

export interface HealthMonitorOptions {
  clock?: HealthClock;
  /** Writes one meta value. Errors are swallowed by the monitor. */
  writeMeta(key: string, value: string): void;
  keepAliveIntervalMs?: number;
}

/** Stall threshold: max(4 x keepalive, 5 min). */
export function stallThresholdMs(keepAliveIntervalMs: number = DEFAULT_KEEPALIVE_MS): number {
  return Math.max(4 * keepAliveIntervalMs, 300_000);
}

export class HealthMonitor {
  private readonly clock: HealthClock;
  private readonly write: (k: string, v: string) => void;
  private readonly stallMs: number;

  private lastWall: number;
  private lastMono: number;
  private open = false;
  private framesSeen = false;
  private connectedMono = 0;
  private lastFrameMono = 0;
  private lastAppMono = 0;
  private lastFrameWall: number | null = null;
  private lastAppWall: number | null = null;
  private connectedWall: number | null = null;
  private reasonText: string | null = null;
  private reconnectTimes: number[] = [];
  private dirty = false;
  private lastWrite = Number.NEGATIVE_INFINITY;

  constructor(opts: HealthMonitorOptions) {
    this.clock = opts.clock ?? systemClock;
    this.write = opts.writeMeta;
    this.stallMs = stallThresholdMs(opts.keepAliveIntervalMs);
    this.lastWall = this.clock.wall();
    this.lastMono = this.clock.mono();
  }

  /** A socket opened: reset the per-connection markers. */
  connected(): void {
    this.open = true;
    this.framesSeen = false;
    this.connectedMono = this.clock.mono();
    this.connectedWall = this.clock.wall();
    this.lastFrameMono = this.connectedMono;
    this.lastAppMono = this.connectedMono;
    this.dirty = true;
    this.flush();
  }

  /** The socket closed or is being replaced. */
  disconnected(): void {
    this.open = false;
  }

  /** Any incoming websocket frame (keepalive acks included). */
  frame(): void {
    this.framesSeen = true;
    this.lastFrameMono = this.clock.mono();
    this.lastFrameWall = this.clock.wall();
    this.dirty = true;
    this.flush();
  }

  /** Any application event (messages, chats, contacts, groups, activity...). */
  appEvent(): void {
    this.lastAppMono = this.clock.mono();
    this.lastAppWall = this.clock.wall();
    this.dirty = true;
    this.flush();
  }

  /** Records a reconnect and why. Written immediately. */
  reconnect(reason: string): void {
    this.reconnectTimes.push(this.clock.wall());
    this.reasonText = reason;
    this.dirty = true;
    this.flush(true);
  }

  reconnects24h(): number {
    this.prune();
    return this.reconnectTimes.length;
  }

  private prune(): void {
    const cutoff = this.clock.wall() - DAY_MS;
    while (this.reconnectTimes.length && (this.reconnectTimes[0] as number) <= cutoff) this.reconnectTimes.shift();
  }

  /**
   * Called every HEALTH_TICK_MS. 'sleep' when wall-clock time ran ahead of the monotonic clock by more than
   * 60 s (machine slept) or the tick itself was late by that much; 'stall' when the socket is open but neither a
   * frame nor an app event arrived for the stall threshold. A quiet account with frames still flowing is fine.
   */
  tick(): HealthAction {
    const w = this.clock.wall();
    const m = this.clock.mono();
    const dWall = w - this.lastWall;
    const dMono = m - this.lastMono;
    this.lastWall = w;
    this.lastMono = m;
    this.flush();
    if (dWall - dMono > SLEEP_JUMP_MS || dMono - HEALTH_TICK_MS > SLEEP_JUMP_MS) return 'sleep';
    if (!this.open || !this.framesSeen) return null; // without frames Baileys' own watchdog is the authority
    const idleSince = Math.max(this.lastFrameMono, this.lastAppMono, this.connectedMono);
    return m - idleSince > this.stallMs ? 'stall' : null;
  }

  /** Writes the meta values when dirty and at most once per 10 s (unless forced). */
  flush(force = false): void {
    if (!this.dirty) return;
    const now = this.clock.wall();
    if (!force && now - this.lastWrite < HEALTH_WRITE_THROTTLE_MS) return;
    this.lastWrite = now;
    this.dirty = false;
    const s = (ms: number | null): string => (ms === null ? '' : String(Math.floor(ms / 1000)));
    const entries: Array<[string, string]> = [
      [HEALTH_META.lastFrameAt, s(this.lastFrameWall)],
      [HEALTH_META.lastAppEventAt, s(this.lastAppWall)],
      [HEALTH_META.connectedAt, s(this.connectedWall)],
      [HEALTH_META.reconnects24h, String(this.reconnects24h())],
      [HEALTH_META.lastReason, this.reasonText ?? ''],
    ];
    for (const [k, v] of entries) {
      try { this.write(k, v); } catch { /* health is best effort */ }
    }
  }
}

// ---------- proxy ----------

const WA_HOST = 'web.whatsapp.com';

/** True if `host` is covered by a NO_PROXY list ("*", "example.com", ".example.com", "*.example.com", with optional ports). */
export function noProxyMatches(list: string | undefined, host: string = WA_HOST): boolean {
  if (!list) return false;
  const h = host.toLowerCase();
  for (const raw of list.split(/[,\s]+/)) {
    let e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e === '*') return true;
    e = e.replace(/:\d+$/, '').replace(/^\*?\./, '');
    if (e && (h === e || h.endsWith(`.${e}`))) return true;
  }
  return false;
}

function parseProxy(raw: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

/** The proxy URL to use for WhatsApp, or null (none set, unparseable, or NO_PROXY matches web.whatsapp.com). */
export function proxyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = [env['HTTPS_PROXY'], env['https_proxy'], env['HTTP_PROXY'], env['http_proxy']].find((v) => v && v.trim());
  if (!raw) return null;
  if (noProxyMatches(env['NO_PROXY'] ?? env['no_proxy'])) return null;
  return parseProxy(raw.trim()) ? raw.trim() : null;
}

/** For diagnose: whether a proxy is in effect and its host (host:port, never user/password). */
export function proxyInfo(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; host: string | null } {
  const raw = proxyUrlFromEnv(env);
  const url = raw ? parseProxy(raw) : null;
  return url ? { enabled: true, host: url.host } : { enabled: false, host: null };
}

/** An HttpsProxyAgent for the Baileys `agent`/`fetchAgent` options, or undefined when no proxy applies. */
export function createProxyAgent(env: NodeJS.ProcessEnv = process.env): Agent | undefined {
  const raw = proxyUrlFromEnv(env);
  if (!raw) return undefined;
  const url = parseProxy(raw) as URL;
  return new HttpsProxyAgent(url.href) as unknown as Agent;
}
