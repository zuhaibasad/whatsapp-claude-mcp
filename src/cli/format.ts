/** Formats unix seconds in an IANA time zone as `YYYY-MM-DD HH:mm`. */
export function formatTs(ts: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "5 min ago", "3 h ago", "2 d ago". */
export function relativeAgo(ts: number, nowSec: number): string {
  const d = Math.max(0, nowSec - ts);
  if (d < 90) return 'just now';
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 129600) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** Collapses whitespace so one message is one line. */
export function oneLine(s: string | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}
