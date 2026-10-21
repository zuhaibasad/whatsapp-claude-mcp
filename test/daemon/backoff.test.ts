import { describe, expect, it } from 'vitest';
import { Backoff, shouldReconnect } from '../../src/daemon/backoff.js';
import type { ConnectionState } from '../../src/core/contracts.js';

type CloseState = Extract<ConnectionState, { state: 'close' }>;

const noJitter = () => new Backoff({ random: () => 0.5 });

describe('Backoff', () => {
  it('doubles from 5s and caps at 600s without jitter', () => {
    const b = noJitter();
    const seq = Array.from({ length: 9 }, () => b.next());
    expect(seq).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 320000, 600000, 600000]);
  });

  it('tracks attempts and resets', () => {
    const b = noJitter();
    expect(b.attempts).toBe(0);
    b.next();
    b.next();
    expect(b.attempts).toBe(2);
    b.reset();
    expect(b.attempts).toBe(0);
    expect(b.next()).toBe(5000);
  });

  it('keeps jittered delays within bounds', () => {
    const extremes = [() => 0, () => 0.999999];
    for (const random of extremes) {
      const b = new Backoff({ random });
      for (let i = 0; i < 12; i++) {
        const d = b.next();
        expect(d).toBeGreaterThanOrEqual(4000);
        expect(d).toBeLessThanOrEqual(600000);
      }
    }
  });

  it('applies ±20% jitter on the first delay', () => {
    expect(new Backoff({ random: () => 0 }).next()).toBe(4000);
    expect(new Backoff({ random: () => 0.999999 }).next()).toBe(6000);
  });

  it('accepts partial options', () => {
    const b = new Backoff({ baseMs: 1000, random: () => 0.5 });
    expect([b.next(), b.next()]).toEqual([1000, 2000]);
  });
});

describe('shouldReconnect', () => {
  const close = (reason: CloseState['reason'], retry: boolean): CloseState => ({
    state: 'close',
    reason,
    retry,
  });

  it.each<[CloseState, boolean]>([
    [close('logged_out', true), false],
    [close('forbidden', true), false],
    [close('replaced', true), false],
    [close('bad_session', true), false],
    [close('restart_required', true), true],
    [close('restart_required', false), false],
    [close('connection_lost', true), true],
    [close('connection_lost', false), false],
    [close('unknown', true), true],
    [close('unknown', false), false],
  ])('%j -> %s', (reason, expected) => {
    expect(shouldReconnect(reason)).toBe(expected);
  });
});
