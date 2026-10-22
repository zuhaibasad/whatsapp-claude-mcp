import fs from 'node:fs';

export class DaemonAlreadyRunningError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`chatai daemon is already running (pid ${pid})`);
    this.name = 'DaemonAlreadyRunningError';
    this.pid = pid;
  }
}

interface LockContents {
  pid: number;
  startedAt: number;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else, so it is alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Parses the lock file. Returns null if it is missing or not valid lock JSON. */
function parseLock(file: string): LockContents | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockContents>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/**
 * Takes the single-instance lock. Throws DaemonAlreadyRunningError if a live process holds it.
 * A stale lock (dead pid or corrupt file) is removed and taken over.
 */
export function acquireLock(file: string): { release(): void } {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        const body: LockContents = { pid: process.pid, startedAt: Date.now() };
        fs.writeSync(fd, JSON.stringify(body));
      } finally {
        fs.closeSync(fd);
      }
      return {
        release(): void {
          const current = parseLock(file);
          if (current && current.pid === process.pid) {
            try {
              fs.unlinkSync(file);
            } catch {
              // Already gone; nothing to release.
            }
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const existing = parseLock(file);
    if (existing && isAlive(existing.pid)) {
      throw new DaemonAlreadyRunningError(existing.pid);
    }
    // Stale or corrupt: remove it and retry the exclusive create.
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new Error(`could not acquire daemon lock at ${file}`);
}

/** Reads the lock for `status`. Returns null if there is no valid lock file. */
export function readLock(file: string): { pid: number; startedAt: number; alive: boolean } | null {
  const contents = parseLock(file);
  if (!contents) return null;
  return { ...contents, alive: isAlive(contents.pid) };
}
