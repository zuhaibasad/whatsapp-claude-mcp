import fs from 'node:fs';
import { resolvePaths } from '../../core/paths.js';
import type { WaClient } from '../../core/contracts.js';
import { useDbAuthState } from '../../daemon/wa/index.js';
import type { CliDeps } from '../deps.js';
import { CliError, type Io } from '../io.js';
import { openAuthDb, openStore, requireInitialised } from '../open.js';
import { stopRunningDaemon } from './daemon.js';

const CONFIRM_WORD = 'unlink';

export interface UnlinkOpts {
  project: string;
  keepData?: boolean;
}

function rmDb(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
}

/** Resolves true on the first `open` event, false on timeout or a close. */
function waitForOpen(client: WaClient, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    client.on('connection', (s) => {
      if (s.state === 'open') {
        clearTimeout(timer);
        resolve(true);
      } else if (s.state === 'close') {
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}

export async function unlinkCommand(opts: UnlinkOpts, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  requireInitialised(paths);
  const keep = opts.keepData === true;

  io.out('This will remove the linked device from your WhatsApp account and delete the local session.');
  io.out(keep ? 'Your stored messages and settings are kept (--keep-data).'
    : 'All local wa-bridge data (messages, settings, exports) and the keychain key will be deleted too.');
  const answer = await io.prompt(`Type "${CONFIRM_WORD}" to continue: `);
  if (answer.trim() !== CONFIRM_WORD) throw new CliError('Aborted: nothing was changed.');

  await stopRunningDaemon(paths, io, deps);

  let remoteDone = false;
  let note: string | null = null;
  if (fs.existsSync(paths.authDb) && deps.keyStore(paths.projectRoot).get() !== null) {
    const db = openAuthDb(paths, deps, { create: false });
    try {
      const auth = await useDbAuthState(db);
      if (auth.hasCreds()) {
        const client = deps.createClient(auth, paths.logFile);
        try {
          const opened = waitForOpen(client, deps.unlinkOpenTimeoutMs);
          await client.connect();
          if (await opened) {
            await client.unlink();
            remoteDone = true;
          } else {
            note = 'Could not reach WhatsApp in time.';
          }
        } catch (e) {
          note = `WhatsApp logout failed (${e instanceof Error ? e.message : 'unknown error'}).`;
        } finally {
          try {
            await client.close();
          } catch {
            /* ignore */
          }
        }
      } else {
        note = 'No linked session was stored.';
      }
    } finally {
      db.close();
    }
  }

  if (keep && fs.existsSync(paths.storeDb)) {
    try {
      const { store, close } = openStore(paths, deps, { write: true });
      try {
        store.setLinkStatus('unlinked');
      } finally {
        close();
      }
    } catch {
      /* status is cosmetic */
    }
  }

  rmDb(paths.authDb);
  fs.rmSync(paths.qrPng, { force: true });
  fs.rmSync(paths.lockFile, { force: true });
  if (!keep) {
    rmDb(paths.storeDb);
    for (const f of [paths.config, paths.departments, paths.priorities, paths.logFile]) fs.rmSync(f, { force: true });
    fs.rmSync(paths.exportsDir, { recursive: true, force: true });
    try {
      fs.rmdirSync(paths.dataDir); // only succeeds when empty
    } catch {
      /* leave unknown files alone */
    }
    deps.keyStore(paths.projectRoot).delete();
  }

  io.out('');
  io.out('Summary:');
  io.out(`  WhatsApp device removed:  ${remoteDone ? 'yes' : 'no'}`);
  io.out('  Local session deleted:    yes');
  io.out(`  Local data deleted:       ${keep ? 'no (kept)' : 'yes'}`);
  io.out(`  Keychain key removed:     ${keep ? 'no (kept)' : 'yes'}`);
  if (!remoteDone) {
    if (note) io.out(`  Note: ${note}`);
    if (note !== 'No linked session was stored.') {
      io.out('  Remove the device manually: WhatsApp -> Settings -> Linked devices -> select this device -> Log out.');
    }
  }
  return 0;
}
