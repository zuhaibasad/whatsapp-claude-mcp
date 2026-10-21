const UNIT_SECONDS: Record<string, number> = { m: 60, h: 3600, d: 86400 };

/** Parses `30d`, `12h`, `90m` into seconds. Throws on anything else. */
export function parseDuration(input: string): number {
  const m = /^(\d+)\s*([dhm])$/i.exec(input.trim());
  if (!m) throw new Error(`Invalid duration "${input}". Use forms like 30d, 12h or 90m.`);
  const n = Number(m[1]);
  if (n <= 0) throw new Error(`Duration must be greater than zero: "${input}".`);
  return n * (UNIT_SECONDS[(m[2] ?? '').toLowerCase()] ?? 0);
}

/** A duration (meaning "that long ago") or an ISO timestamp, as unix seconds. */
export function parseSince(input: string, nowSec: number): number {
  const s = input.trim();
  if (/^\d+\s*[dhm]$/i.test(s)) return nowSec - parseDuration(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Invalid time "${input}". Use 7d, 12h, 90m or an ISO timestamp.`);
  return Math.floor(ms / 1000);
}
