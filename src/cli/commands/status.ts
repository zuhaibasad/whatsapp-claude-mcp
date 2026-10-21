import { resolvePaths } from '../../core/paths.js';
import { loadConfig } from '../../config/index.js';
import { readLock } from '../../daemon/lock.js';
import type { CliDeps } from '../deps.js';
import { formatTs, relativeAgo } from '../format.js';
import type { Io } from '../io.js';
import { isInitialised, openStore } from '../open.js';

const STALE_SYNC_MIN = 60;

/** Meta timestamps may be stored in seconds or milliseconds. Returns seconds. */
function metaSeconds(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

export async function statusCommand(opts: { project: string; json?: boolean }, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  if (!isInitialised(paths)) {
    if (opts.json) io.out(JSON.stringify({ initialised: false }));
    else io.out('Not initialised. Run: wa-bridge init');
    return 2;
  }

  const nowSec = Math.floor(deps.now() / 1000);
  const { config } = loadConfig(paths);
  const lock = readLock(paths.lockFile);
  const daemonRunning = lock?.alive === true;

  const opened = openStore(paths, deps, { write: false });
  try {
    const { store } = opened;
    const account = store.getAccount();
    const counts = store.counts();
    const lastSync = metaSeconds(store.getMeta('last_sync_at'));
    const lastConnected = account?.lastConnectedAt ?? null;
    const linkStatus = account?.linkStatus ?? 'unlinked';

    const warnings: string[] = [];
    if (linkStatus === 'logged_out') warnings.push('WhatsApp logged this device out. Run: wa-bridge unlink, then wa-bridge link');
    else if (linkStatus === 'unlinked') warnings.push('No account linked. Run: wa-bridge link');
    if (!daemonRunning && linkStatus !== 'unlinked') warnings.push('The daemon is not running. Run: wa-bridge daemon start');
    if (daemonRunning && lastSync !== null && (nowSec - lastSync) / 60 > STALE_SYNC_MIN) {
      warnings.push(`No sync for more than ${STALE_SYNC_MIN} minutes.`);
    }

    if (opts.json) {
      io.out(JSON.stringify({
        initialised: true,
        linkStatus,
        account: account ? { id: account.id, pushName: account.pushName } : null,
        daemon: { running: daemonRunning, pid: daemonRunning ? lock?.pid ?? null : null,
          startedAt: lock ? Math.floor(lock.startedAt / 1000) : null },
        lastConnectedAt: lastConnected,
        lastSyncAt: lastSync,
        counts,
        retentionDays: config.retentionDays,
        warnings,
      }, null, 2));
      return 0;
    }

    const ago = (ts: number | null): string =>
      ts === null ? 'never' : `${formatTs(ts, config.timezone)} (${relativeAgo(ts, nowSec)})`;
    io.out('Initialised:     yes');
    io.out(`Link status:     ${linkStatus}`);
    io.out(`Account:         ${account ? `${account.id}${account.pushName ? ` (${account.pushName})` : ''}` : '-'}`);
    io.out(`Daemon:          ${daemonRunning ? `running (pid ${lock?.pid})` : 'not running'}`);
    io.out(`Last connected:  ${ago(lastConnected)}`);
    io.out(`Last sync:       ${lastSync === null ? 'never' : `${Math.round((nowSec - lastSync) / 60)} min ago`}`);
    io.out(`Chats:           ${counts.chatsIncluded} included of ${counts.chatsTotal}`);
    io.out(`Messages:        ${counts.messages}`);
    io.out(`Open items:      ${counts.openItems}`);
    io.out(`Retention:       ${config.retentionDays} days`);
    for (const w of warnings) io.out(`WARNING: ${w}`);
    return 0;
  } finally {
    opened.close();
  }
}
