import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, DaemonAlreadyRunningError, readLock } from '../../src/daemon/lock.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lock-test-'));
  file = path.join(dir, 'daemon.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('writes pid and startedAt, and removes the file on release', () => {
    const before = Date.now();
    const lock = acquireLock(file);
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; startedAt: number };
    expect(body.pid).toBe(process.pid);
    expect(body.startedAt).toBeGreaterThanOrEqual(before);
    lock.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('throws DaemonAlreadyRunningError when a live process holds the lock', () => {
    const first = acquireLock(file);
    let caught: unknown;
    try {
      acquireLock(file);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonAlreadyRunningError);
    expect((caught as DaemonAlreadyRunningError).pid).toBe(process.pid);
    first.release();
  });

  it('takes over a stale lock whose pid is dead', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: 1 }));
    const lock = acquireLock(file);
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
    expect(body.pid).toBe(process.pid);
    lock.release();
  });

  it('takes over a corrupt lock file', () => {
    fs.writeFileSync(file, 'not json');
    const lock = acquireLock(file);
    expect(readLock(file)?.pid).toBe(process.pid);
    lock.release();
  });

  it('release does not delete a lock owned by another pid', () => {
    const lock = acquireLock(file);
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: 1 }));
    lock.release();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('readLock', () => {
  it('returns null when there is no lock file', () => {
    expect(readLock(file)).toBeNull();
  });

  it('reports alive for the current process', () => {
    const lock = acquireLock(file);
    expect(readLock(file)).toMatchObject({ pid: process.pid, alive: true });
    lock.release();
  });

  it('reports alive=false for a dead pid without removing the file', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: 42 }));
    expect(readLock(file)).toEqual({ pid: 999999, startedAt: 42, alive: false });
    expect(fs.existsSync(file)).toBe(true);
  });
});
