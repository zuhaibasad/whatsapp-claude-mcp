import type { ConnectionState } from '../core/contracts.js';

export interface BackoffOptions {
  baseMs: number;
  factor: number;
  maxMs: number;
  /** Fraction of the delay, e.g. 0.2 means ±20%. */
  jitter: number;
  /** Returns a number in [0, 1). Injected so tests can remove randomness. */
  random: () => number;
}

const DEFAULTS: BackoffOptions = {
  baseMs: 5000,
  factor: 2,
  maxMs: 600000,
  jitter: 0.2,
  random: Math.random,
};

/** Exponential reconnect delay with jitter. Call `reset()` after a successful open. */
export class Backoff {
  private readonly opts: BackoffOptions;
  private count = 0;

  constructor(opts: Partial<BackoffOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Number of delays handed out since the last reset. */
  get attempts(): number {
    return this.count;
  }

  /**
   * Returns the next delay in ms. The first call is about baseMs, then it grows by `factor`
   * up to maxMs. Jitter is applied around that value; the result stays within
   * [baseMs * 0.8, maxMs].
   */
  next(): number {
    const { baseMs, factor, maxMs, jitter, random } = this.opts;
    const raw = Math.min(baseMs * Math.pow(factor, this.count), maxMs);
    this.count += 1;
    const offset = (random() * 2 - 1) * jitter; // in [-jitter, +jitter)
    const jittered = raw * (1 + offset);
    const floor = baseMs * 0.8;
    return Math.round(Math.min(Math.max(jittered, floor), maxMs));
  }

  reset(): void {
    this.count = 0;
  }
}

type CloseState = Extract<ConnectionState, { state: 'close' }>;

const NEVER_RECONNECT: ReadonlySet<CloseState['reason']> = new Set([
  'logged_out',
  'forbidden',
  'replaced',
  'bad_session',
]);

/** Whether the daemon should try to reconnect after a close. */
export function shouldReconnect(reason: CloseState): boolean {
  if (NEVER_RECONNECT.has(reason.reason)) return false;
  return reason.retry;
}
