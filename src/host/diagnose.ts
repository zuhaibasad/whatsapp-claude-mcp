// Health check ("diagnose") shared by the collector host, whatsapp_status {diagnose:true}, POST /api/diagnose and
// `chatai doctor`. Every detail/fix is plain language. Never includes keys, tokens, nonces, QR data or message text.
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from '../core/constants.js';
import type { CollectorState, Diagnosis, DiagnosisCheck } from '../core/service.js';
import type { DataPaths } from '../core/paths.js';
import { readLock } from '../daemon/lock.js';
import { listBackups } from './backup.js';

export const LOW_DISK_BYTES = 500 * 1024 * 1024;

export interface DiagnoseInput {
  paths: DataPaths;
  version: string;
  now: () => number;
  /** null = the keychain could not be read. */
  keyPresent: boolean | null;
  /** Read-only view of the store; null when it is not open / not initialised. */
  meta: ((key: string) => string | null) | null;
  linkStatus: string | null;
  collector: CollectorState | null;
  /** Test hooks. */
  freeBytes?: () => number | null;
  env?: NodeJS.ProcessEnv;
  lock?: () => { pid: number; alive: boolean } | null;
}

const check = (name: string, ok: boolean, detail: string, fix?: string): DiagnosisCheck =>
  fix && !ok ? { name, ok, detail, fix } : { name, ok, detail };

function seconds(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

export function agoText(sec: number | null, nowSec: number): string {
  if (sec === null) return 'never';
  const d = Math.max(0, nowSec - sec);
  if (d < 90) return 'just now';
  const m = Math.floor(d / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hours ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** True when the folder is under Claude Desktop's MSIX package storage (a different folder than other programs see). */
export function isMsixRedirected(dir: string): boolean {
  return /[\\/]Packages[\\/]Claude_/i.test(dir);
}

/** "host:port" of the configured proxy, never credentials; null when none is set. */
export function proxyFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env['HTTPS_PROXY'] ?? env['https_proxy'] ?? env['ALL_PROXY'] ?? env['all_proxy'] ?? env['HTTP_PROXY'] ?? env['http_proxy'];
  if (!raw) return null;
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return u.host || 'configured';
  } catch {
    return 'configured';
  }
}

function freeSpace(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function safeReason(v: string | null): string | null {
  if (!v) return null;
  return v.replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);
}

export function buildDiagnosis(input: DiagnoseInput): Diagnosis {
  const { paths } = input;
  const nowSec = Math.floor(input.now() / 1000);
  const meta = (k: string): string | null => {
    try { return input.meta?.(k) ?? null; } catch { return null; }
  };
  const checks: DiagnosisCheck[] = [];

  // data folder
  const exists = fs.existsSync(paths.dataDir);
  if (!exists) {
    checks.push(check('data_dir', false, 'The ChatAI data folder does not exist yet.', 'Say "set up WhatsApp" to create it.'));
  } else if (isMsixRedirected(paths.dataDir)) {
    checks.push(check('data_dir', false,
      'The data folder is inside Claude Desktop\'s private package storage, so other programs (like Claude Code) will not see the same data.',
      'Move to the default folder: set the data folder to your user folder (.chatai) in the extension settings, or ask support.'));
  } else {
    checks.push(check('data_dir', true, `The data folder exists (${paths.dataDir}).`));
  }

  // keychain key
  if (input.keyPresent === null) {
    checks.push(check('keychain', false, 'Could not read the Windows Credential Manager.', 'Make sure you are signed in to Windows normally, then restart Claude.'));
  } else if (!input.keyPresent) {
    checks.push(check('keychain', false, 'The encryption key was not found in the Windows Credential Manager.',
      exists && fs.existsSync(paths.storeDb)
        ? 'The stored messages cannot be opened without the key. Disconnect and delete everything, then set up again.'
        : 'Say "set up WhatsApp" to create it.'));
  } else {
    checks.push(check('keychain', true, 'The encryption key is present.'));
  }

  // lock holder
  let lock: { pid: number; alive: boolean } | null = null;
  try { lock = input.lock ? input.lock() : readLock(paths.lockFile); } catch { lock = null; }
  checks.push(lock?.alive
    ? check('lock_holder', true, `The collector is running (process ${lock.pid}).`)
    : check('lock_holder', false, 'The collector is not running (it runs while Claude is open).', 'Open Claude Desktop (or restart it) so the connector starts.'));

  // link
  const link = input.linkStatus ?? 'unlinked';
  if (link === 'linked' || link === 'connecting' || link === 'disconnected') {
    checks.push(check('link', link === 'linked', link === 'linked' ? 'WhatsApp is linked.' : `WhatsApp is linked; the connection is ${link}.`, 'Check your internet connection; it reconnects by itself.'));
  } else if (link === 'logged_out') {
    checks.push(check('link', false, 'WhatsApp logged this device out.', 'Say "set up WhatsApp" and scan the code again.'));
  } else {
    checks.push(check('link', false, 'No WhatsApp account is linked.', 'Say "set up WhatsApp".'));
  }

  // schema
  const schema = Number(meta('schema_version'));
  if (!input.meta || !Number.isFinite(schema) || schema <= 0) {
    checks.push(check('schema', false, 'The message database could not be read.', 'Restart Claude. If it keeps happening, ask support.'));
  } else if (schema === SCHEMA_VERSION) {
    checks.push(check('schema', true, `The message database is up to date (version ${schema}).`));
  } else if (schema < SCHEMA_VERSION) {
    checks.push(check('schema', false, `The message database is on an older version (${schema}, expected ${SCHEMA_VERSION}).`, 'Restart Claude; it upgrades automatically and keeps a backup.'));
  } else {
    checks.push(check('schema', false, `The message database is from a newer ChatAI (version ${schema}, this one supports ${SCHEMA_VERSION}).`, 'Update the ChatAI for WhatsApp extension.'));
  }

  // collector
  const lastLive = seconds(meta('last_live_at'));
  const col = input.collector ?? 'not_linked';
  const colOk = col === 'live' || col === 'catching_up' || col === 'connecting' || (col === 'not_linked' && link === 'unlinked');
  checks.push(check('collector', colOk,
    `The collector is ${col.replace('_', ' ')}; last fully up to date ${agoText(lastLive, nowSec)}.`,
    col === 'logged_out' ? 'Say "set up WhatsApp" to link again.' : 'Wait a minute. If it stays like this, check your internet connection and restart Claude.'));

  // connection health (written by the collector; absent on older builds)
  const lastFrame = seconds(meta('health_last_frame_at'));
  const reconnectsRaw = meta('health_reconnects_24h');
  const reconnects = reconnectsRaw === null ? null : Number(reconnectsRaw);
  const reason = safeReason(meta('health_last_reason'));
  if (lastFrame === null && reconnects === null && reason === null) {
    checks.push(check('connection', true, 'No connection health data recorded yet.'));
  } else {
    const silentMin = lastFrame === null ? null : Math.max(0, Math.round((nowSec - lastFrame) / 60));
    const flaky = reconnects !== null && Number.isFinite(reconnects) && reconnects > 10;
    const silent = col === 'live' && silentMin !== null && silentMin > 30;
    const parts = [
      `last data from WhatsApp ${agoText(lastFrame, nowSec)}`,
      reconnects !== null && Number.isFinite(reconnects) ? `${reconnects} reconnect${reconnects === 1 ? '' : 's'} in the last 24 hours` : null,
      reason ? `last problem: ${reason}` : null,
    ].filter((x): x is string => x !== null);
    checks.push(check('connection', !flaky && !silent, `${parts.join('; ')}.`,
      'Check your internet connection, VPN or proxy. If it keeps dropping, restart Claude.'));
  }

  // proxy
  const proxy = proxyFromEnv(input.env ?? process.env);
  checks.push(check('proxy', true, proxy ? `Using a proxy (${proxy}).` : 'No proxy configured (direct connection).'));

  // disk space
  const free = input.freeBytes ? input.freeBytes() : freeSpace(exists ? paths.dataDir : path.dirname(paths.dataDir));
  if (free === null) {
    checks.push(check('disk', true, 'Free disk space could not be measured.'));
  } else {
    const mb = Math.floor(free / (1024 * 1024));
    const gb = free / (1024 ** 3);
    checks.push(check('disk', free >= LOW_DISK_BYTES,
      free >= 10 * 1024 ** 3 ? `${gb.toFixed(0)} GB free on the data drive.` : `${mb} MB free on the data drive.`,
      'Free some space on this drive; ChatAI needs room to store messages.'));
  }

  // backups
  const backups = listBackups(paths.dataDir);
  const lastBackup = seconds(meta('last_backup_at'));
  checks.push(check('backups', true, backups.length === 0
    ? 'No backups yet (one is made automatically before a database upgrade).'
    : `${backups.length} backup${backups.length === 1 ? '' : 's'} (${backups.map((b) => b.name).join(', ')}); last made ${agoText(lastBackup, nowSec)}.`));

  return { version: input.version, dataDir: paths.dataDir, checks };
}
