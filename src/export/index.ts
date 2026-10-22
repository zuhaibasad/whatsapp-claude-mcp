import fs from 'node:fs';
import path from 'node:path';
import type { Item } from '../core/types.js';
import type { DataPaths } from '../core/paths.js';

/** An item joined with its chat name, as returned by Store.listItems. */
export type ItemWithChat = Item & { chatName: string | null; sourcePurged: boolean };

export type ExportFormat = 'csv' | 'json';

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** ISO-8601 with the UTC offset of an IANA zone, e.g. 2026-10-21T14:05:00+05:00. Falls back to UTC. */
export function isoInZone(ts: number, timezone: string): string {
  const d = new Date(ts * 1000);
  try {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d)) parts[p.type] = p.value;
    const asUtc = Date.UTC(+(parts.year ?? 0), +(parts.month ?? 1) - 1, +(parts.day ?? 1), +(parts.hour ?? 0), +(parts.minute ?? 0), +(parts.second ?? 0));
    const offMin = Math.round((asUtc - Math.floor(ts) * 1000) / 60000);
    const sign = offMin < 0 ? '-' : '+';
    const abs = Math.abs(offMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
  } catch {
    return d.toISOString();
  }
}

export interface ItemRow {
  id: number;
  ref: string;
  chat_name: string | null;
  category: string;
  department: string | null;
  priority: string;
  summary: string;
  requester: string | null;
  status: string;
  age_hours: number;
  created_at: string;
  updated_at: string;
  source_purged: boolean;
}

export function itemRow(it: ItemWithChat, nowSec: number, timezone: string): ItemRow {
  return {
    id: it.id,
    ref: `${it.chatId}/${it.messageId}`,
    chat_name: it.chatName,
    category: it.category,
    department: it.department,
    priority: it.priority,
    summary: it.summary,
    requester: it.requester,
    status: it.status,
    age_hours: Math.max(0, Math.round(((nowSec - it.createdAt) / 3600) * 10) / 10),
    created_at: isoInZone(it.createdAt, timezone),
    updated_at: isoInZone(it.updatedAt, timezone),
    source_purged: it.sourcePurged,
  };
}

const CSV_COLUMNS: (keyof ItemRow)[] = [
  'id', 'status', 'priority', 'category', 'department', 'requester', 'chat_name', 'summary',
  'ref', 'age_hours', 'created_at', 'updated_at', 'source_purged',
];

/** RFC 4180 cell. Text that starts with = + - @ is prefixed with ' so Excel does not run it as a formula. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text with a UTF-8 BOM (so Excel shows Urdu correctly) and CRLF line ends. */
export function toCsv(rows: ItemRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function nearestExisting(p: string): string {
  let cur = p;
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return cur;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Resolves a requested export path. Throws ExportError unless it lies inside the project folder (symlinks included). */
export function resolveExportPath(paths: DataPaths, requested: string | undefined, format: ExportFormat, nowMs: number): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const wanted = requested && requested.trim() !== '' ? requested.trim() : path.join(paths.exportsDir, `items-${date}.${format}`);
  const root = path.resolve(paths.projectRoot);
  const target = path.resolve(root, wanted);
  if (!isInside(root, target)) throw new ExportError('path must be inside the project folder');
  // Defeat symlinks/junctions: the nearest existing ancestor must also resolve inside the real root.
  const realRoot = fs.realpathSync(root);
  const realAnc = fs.realpathSync(nearestExisting(target));
  if (realAnc !== realRoot && !isInside(realRoot, realAnc)) throw new ExportError('path must be inside the project folder');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new ExportError('path is a directory; give a file name');
  return target;
}

export interface ExportResult {
  /** Project-relative, forward slashes. */
  path: string;
  count: number;
}

export function writeItemsExport(opts: {
  paths: DataPaths;
  items: ItemWithChat[];
  format: ExportFormat;
  path?: string;
  nowMs: number;
  timezone: string;
}): ExportResult {
  const target = resolveExportPath(opts.paths, opts.path, opts.format, opts.nowMs);
  const nowSec = Math.floor(opts.nowMs / 1000);
  const rows = opts.items.map((i) => itemRow(i, nowSec, opts.timezone));
  const body = opts.format === 'csv' ? toCsv(rows) : JSON.stringify({ count: rows.length, items: rows }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
  return { path: path.relative(opts.paths.projectRoot, target).split(path.sep).join('/'), count: rows.length };
}
