import { resolvePaths, type DataPaths } from '../../core/paths.js';
import { readLock } from '../../daemon/lock.js';
import type { CliDeps } from '../deps.js';
import { CliError, type Io } from '../io.js';
import { requireInitialised } from '../open.js';

export interface DaemonStartOpts {
  project: string;
  detach?: boolean;
}

export async function daemonStartCommand(opts: DaemonStartOpts, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  requireInitialised(paths);

  const lock = readLock(paths.lockFile);
  if (lock?.alive) throw new CliError(`The daemon is already running (pid ${lock.pid}).`);

  if (opts.detach) {
    const pid = deps.spawnDetached(['--project', paths.projectRoot, 'daemon', 'start']);
    io.out(pid ? `Daemon started in the background (pid ${pid}). Logs: ${paths.logFile}` : 'Daemon start requested.');
    return 0;
  }

  const handle = await deps.runDaemon({ projectRoot: paths.projectRoot });
  io.out(`Daemon running in the foreground. Logs: ${paths.logFile}. Press Ctrl+C to stop.`);
  if (handle.done) {
    const { reason } = await handle.done;
    const normal = /^(stop|stopped|signal|sigint|sigterm|shutdown|requested)/i.test(reason);
    if (!normal) io.err(`Daemon ended: ${reason}`);
    return normal ? 0 : 1;
  }
  await deps.waitForShutdown();
  io.out('Stopping...');
  try {
    await handle.stop();
  } catch {
    /* the runner may already have stopped itself on the same signal */
  }
  return 0;
}

/** Stops a running daemon and waits for the lock to go away. Returns true if one was running. */
export async function stopRunningDaemon(paths: DataPaths, io: Io, deps: CliDeps): Promise<boolean> {
  const lock = readLock(paths.lockFile);
  if (!lock?.alive) return false;
  io.out(`Stopping daemon (pid ${lock.pid})...`);
  deps.killPid(lock.pid);
  for (let i = 0; i < 50; i++) {
    await deps.sleep(200);
    const l = readLock(paths.lockFile);
    if (!l?.alive) return true;
  }
  throw new CliError(`The daemon (pid ${lock.pid}) did not stop within 10 seconds.`);
}

export async function daemonStopCommand(opts: { project: string }, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  const was = await stopRunningDaemon(paths, io, deps);
  io.out(was ? 'Daemon stopped.' : 'The daemon is not running.');
  return 0;
}

export function daemonPhase3Command(what: 'install' | 'uninstall', io: Io): number {
  io.out(`daemon ${what}: coming in Phase 3.`);
  return 0;
}
