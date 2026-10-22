import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, WaClient } from '../../src/core/contracts.js';
import { createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import {
  DAY_MS, HEALTH_META, HealthMonitor, createProxyAgent, noProxyMatches, proxyInfo, proxyUrlFromEnv, stallThresholdMs,
  type HealthClock,
} from '../../src/daemon/health.js';
import { openDaemonDbs, startCollector, type OpenedDbs, type WaClientFactoryArgs } from '../../src/daemon/runner.js';

class Clock implements HealthClock {
  w = 1_700_000_000_000;
  m = 1000;
  wall(): number { return this.w; }
  mono(): number { return this.m; }
  /** Normal passage of time. */
  adv(ms: number): void { this.w += ms; this.m += ms; }
  /** The machine slept: wall time moved, monotonic time did not. */
  sleep(ms: number): void { this.w += ms; }
}

const OPEN: ConnectionState = { state: 'open', me: { id: '999@s.whatsapp.net', lid: null, pushName: 'Me' } };

describe('HealthMonitor', () => {
  it('detects a sleep jump over 60 s and ignores small drift', () => {
    const c = new Clock();
    const h = new HealthMonitor({ clock: c, writeMeta: () => undefined });
    c.adv(15_000);
    expect(h.tick()).toBeNull();
    c.adv(15_000);
    c.sleep(30_000);
    expect(h.tick()).toBeNull();
    c.adv(15_000);
    c.sleep(3_600_000);
    expect(h.tick()).toBe('sleep');
    c.adv(15_000);
    expect(h.tick()).toBeNull();
  });

  it('also treats a very late tick as sleep (monotonic clock that counts sleep)', () => {
    const c = new Clock();
    const h = new HealthMonitor({ clock: c, writeMeta: () => undefined });
    c.adv(600_000);
    expect(h.tick()).toBe('sleep');
  });

  it('flags a stall only when frames and app events both stop', () => {
    const c = new Clock();
    const h = new HealthMonitor({ clock: c, writeMeta: () => undefined });
    h.connected();
    h.frame();
    let act: ReturnType<HealthMonitor['tick']> = null;
    // frames keep coming every 30 s for 20 minutes: never a stall
    for (let i = 0; i < 40; i++) {
      c.adv(15_000);
      if (i % 2 === 0) h.frame();
      act = h.tick();
      expect(act).toBeNull();
    }
    // frames stop: stall after the threshold (5 min) and not before
    let fired = 0;
    for (let i = 0; i < 40 && !fired; i++) {
      c.adv(15_000);
      if (h.tick() === 'stall') fired = (i + 1) * 15_000;
    }
    expect(fired).toBeGreaterThanOrEqual(stallThresholdMs() - 15_000);
    expect(fired).toBeLessThan(stallThresholdMs() + 60_000);
  });

  it('app events alone also keep it healthy; closed socket never stalls', () => {
    const c = new Clock();
    const h = new HealthMonitor({ clock: c, writeMeta: () => undefined });
    h.connected();
    h.frame();
    for (let i = 0; i < 60; i++) {
      c.adv(15_000);
      if (i % 4 === 0) h.appEvent();
      expect(h.tick()).toBeNull();
    }
    h.disconnected();
    c.adv(3_000_000 / 100);
    expect(h.tick()).toBeNull();
  });

  it('threshold is max(4 x keepalive, 5 min)', () => {
    expect(stallThresholdMs(30_000)).toBe(300_000);
    expect(stallThresholdMs(120_000)).toBe(480_000);
  });

  it('counts reconnects over a rolling 24 h window', () => {
    const c = new Clock();
    const h = new HealthMonitor({ clock: c, writeMeta: () => undefined });
    h.reconnect('a');
    c.adv(DAY_MS / 2);
    h.reconnect('b');
    expect(h.reconnects24h()).toBe(2);
    c.adv(DAY_MS / 2 + 1000);
    expect(h.reconnects24h()).toBe(1);
    c.adv(DAY_MS);
    expect(h.reconnects24h()).toBe(0);
  });

  it('throttles meta writes to one per 10 s', () => {
    const c = new Clock();
    const writes: Array<[string, string]> = [];
    const h = new HealthMonitor({ clock: c, writeMeta: (k, v) => { writes.push([k, v]); } });
    h.frame();
    const first = writes.length;
    expect(first).toBe(5);
    const w0 = c.w;
    for (let i = 0; i < 30; i++) { c.adv(400); h.frame(); }
    expect(writes.length).toBe(first + 5); // one more flush after 10 s, not thirty
    const last = writes.filter(([k]) => k === HEALTH_META.lastFrameAt).pop();
    expect(last?.[1]).toBe(String(Math.floor((w0 + 10_000) / 1000)));
    h.reconnect('app_stall'); // forced
    expect(writes.filter(([k, v]) => k === HEALTH_META.lastReason && v === 'app_stall')).toHaveLength(1);
    expect(writes.filter(([k, v]) => k === HEALTH_META.reconnects24h && v === '1')).toHaveLength(1);
  });
});

describe('proxy', () => {
  it('reads proxy env in priority order', () => {
    expect(proxyUrlFromEnv({})).toBeNull();
    expect(proxyUrlFromEnv({ HTTP_PROXY: 'http://a:1' })).toBe('http://a:1');
    expect(proxyUrlFromEnv({ HTTP_PROXY: 'http://a:1', https_proxy: 'http://b:2' })).toBe('http://b:2');
    expect(proxyUrlFromEnv({ HTTPS_PROXY: '  ' , http_proxy: 'http://c:3' })).toBe('http://c:3');
  });

  it('honours NO_PROXY for web.whatsapp.com', () => {
    expect(noProxyMatches('localhost,.whatsapp.com')).toBe(true);
    expect(noProxyMatches('whatsapp.com')).toBe(true);
    expect(noProxyMatches('*.whatsapp.com:443')).toBe(true);
    expect(noProxyMatches('web.whatsapp.com')).toBe(true);
    expect(noProxyMatches('*')).toBe(true);
    expect(noProxyMatches('example.com, localhost')).toBe(false);
    expect(noProxyMatches('notwhatsapp.com')).toBe(false);
    expect(noProxyMatches(undefined)).toBe(false);
    expect(proxyUrlFromEnv({ HTTPS_PROXY: 'http://a:1', NO_PROXY: '.whatsapp.com' })).toBeNull();
    expect(proxyUrlFromEnv({ HTTPS_PROXY: 'http://a:1', no_proxy: 'corp.local' })).toBe('http://a:1');
  });

  it('proxyInfo returns the host only, never credentials', () => {
    expect(proxyInfo({})).toEqual({ enabled: false, host: null });
    const i = proxyInfo({ HTTPS_PROXY: 'http://user:s3cret@proxy.corp:8080/path' });
    expect(i).toEqual({ enabled: true, host: 'proxy.corp:8080' });
    expect(JSON.stringify(i)).not.toMatch(/s3cret|user/);
    expect(proxyInfo({ HTTPS_PROXY: 'proxy.corp:3128' }).host).toBe('proxy.corp:3128');
    expect(proxyInfo({ HTTPS_PROXY: 'http://x:1', NO_PROXY: 'web.whatsapp.com' }).enabled).toBe(false);
  });

  it('creates an agent only when a proxy applies', () => {
    expect(createProxyAgent({})).toBeUndefined();
    expect(createProxyAgent({ HTTPS_PROXY: 'http://u:p@127.0.0.1:9' })).toBeDefined();
  });
});

// ---- collector integration ----

class FakeClient implements WaClient {
  private readonly ee = new EventEmitter();
  connect = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  unlink = vi.fn(async () => undefined);
  on(event: string, listener: (...a: never[]) => void): void {
    this.ee.on(event, listener as (...a: unknown[]) => void);
  }
  conn(s: ConnectionState): void { this.ee.emit('connection', s); }
}

describe('collector health', () => {
  let dir: string;
  let dbs: OpenedDbs;
  let client: FakeClient;
  let args: WaClientFactoryArgs | null;
  const clock = new Clock();
  const logger = createLogger({ level: 'silent' });

  beforeEach(async () => {
    vi.useFakeTimers();
    clock.w = 1_700_000_000_000;
    clock.m = 1000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-health-'));
    const paths = resolvePaths(dir);
    fs.mkdirSync(paths.dataDir, { recursive: true });
    dbs = await openDaemonDbs(paths, Buffer.alloc(32, 7));
    client = new FakeClient();
    args = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    dbs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = () => startCollector({
    paths: resolvePaths(dir),
    dbs,
    logger,
    waClientFactory: (a) => { args = a; return client; },
    healthClock: clock,
  });
  /** Advance fake timers and the injected clock together. */
  const run = async (ms: number, sleepMs = 0): Promise<void> => {
    for (let left = ms; left > 0; left -= 15_000) {
      const step = Math.min(15_000, left);
      clock.adv(step);
      await vi.advanceTimersByTimeAsync(step);
    }
    if (sleepMs) clock.sleep(sleepMs);
  };

  it('sleep jump forces exactly one immediate reconnect without logout', async () => {
    const c = start();
    expect(client.connect).toHaveBeenCalledTimes(1);
    client.conn(OPEN);
    expect(c.state()).toBe('catching_up');
    await run(15_000);
    clock.sleep(3_600_000);
    await run(15_000);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.unlink).not.toHaveBeenCalled();
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(c.state()).toBe('reconnecting');
    expect(dbs.store.getMeta(HEALTH_META.lastReason)).toBe('sleep_resume');
    expect(dbs.store.getMeta(HEALTH_META.reconnects24h)).toBe('1');
    await run(60_000);
    expect(client.connect).toHaveBeenCalledTimes(2); // still once
    client.conn(OPEN);
    client.conn({ state: 'caught_up' });
    await run(10_000);
    expect(c.state()).toBe('live');
    await c.stop();
  });

  it('does not force a reconnect while mid-connect', async () => {
    const c = start();
    await run(15_000);
    clock.sleep(3_600_000);
    await run(15_000);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.connect).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it('stall forces one reconnect through backoff; steady frames do not', async () => {
    const c = start();
    client.conn(OPEN);
    // frames keep arriving for 10 minutes on a quiet account
    for (let i = 0; i < 20; i++) { args?.onFrame?.(); await run(30_000); }
    expect(client.close).not.toHaveBeenCalled();
    // frames stop
    await run(330_000);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(c.state()).toBe('reconnecting');
    expect(dbs.store.getMeta(HEALTH_META.lastReason)).toBe('app_stall');
    await run(15_000); // backoff delay (about 5 s) has passed by now
    expect(client.connect).toHaveBeenCalledTimes(2);
    await run(600_000); // not open yet: no further forced reconnects
    expect(client.close).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it('writes health meta throttled', async () => {
    const c = start();
    client.conn(OPEN);
    args?.onFrame?.();
    await run(15_000); // the tick flushes the throttled values
    expect(dbs.store.getMeta(HEALTH_META.lastFrameAt)).toBe(String(Math.floor((clock.w - 15_000) / 1000)));
    expect(dbs.store.getMeta(HEALTH_META.connectedAt)).not.toBe('');
    await c.stop();
  });
});
