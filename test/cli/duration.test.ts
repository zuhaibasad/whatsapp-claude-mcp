import { describe, expect, it } from 'vitest';
import { parseDuration, parseSince } from '../../src/cli/duration.js';

describe('parseDuration', () => {
  it.each([
    ['30d', 2592000], ['12h', 43200], ['90m', 5400], ['1D', 86400], [' 7d ', 604800],
  ])('%s', (s, n) => expect(parseDuration(s)).toBe(n));
  it.each(['', '30', 'd', '0d', '-1d', '1.5h', '3w', 'abc'])('rejects %j', (s) => {
    expect(() => parseDuration(s)).toThrow();
  });
});

describe('parseSince', () => {
  it('duration is relative to now', () => expect(parseSince('1h', 10_000)).toBe(6_400));
  it('ISO timestamp', () => expect(parseSince('2026-01-01T00:00:00Z', 0)).toBe(1767225600));
  it('rejects junk', () => expect(() => parseSince('yesterday-ish', 0)).toThrow());
});
