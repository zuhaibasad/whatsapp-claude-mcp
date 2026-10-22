import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import pino from 'pino';
import type makeWASocket from 'baileys';
import { createWaClient } from '../../../src/daemon/wa/wa-client.js';
import { useDbAuthState } from '../../../src/daemon/wa/auth-state.js';

async function build(env: NodeJS.ProcessEnv, onFrame?: () => void) {
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  const configs: Record<string, unknown>[] = [];
  const sock = { ev, ws, user: undefined, end: vi.fn(async () => undefined) };
  const factory = ((cfg: Record<string, unknown>) => { configs.push(cfg); return sock; }) as unknown as typeof makeWASocket;
  const auth = await useDbAuthState(new Database(':memory:'));
  const client = createWaClient({
    auth,
    logger: pino({ level: 'silent' }),
    socketFactory: factory,
    fetchVersion: async () => ({ version: [2, 3000, 1] }),
    env,
    ...(onFrame ? { onFrame } : {}),
  });
  return { client, configs, ws };
}

describe('wa-client proxy and frames', () => {
  it('passes agent and fetchAgent only when a proxy is set', async () => {
    const off = await build({});
    await off.client.connect();
    expect(off.configs[0]).not.toHaveProperty('agent');
    expect(off.configs[0]).not.toHaveProperty('fetchAgent');

    const bypass = await build({ HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: 'web.whatsapp.com' });
    await bypass.client.connect();
    expect(bypass.configs[0]).not.toHaveProperty('agent');

    const on = await build({ HTTPS_PROXY: 'http://u:p@127.0.0.1:9' });
    await on.client.connect();
    expect(on.configs[0]!['agent']).toBeDefined();
    expect(on.configs[0]!['fetchAgent']).toBe(on.configs[0]!['agent']);
    expect(on.configs[0]).toMatchObject({ markOnlineOnConnect: false, syncFullHistory: false });
  });

  it('reports websocket frames to onFrame, only for the live socket', async () => {
    const onFrame = vi.fn();
    const { client, ws } = await build({}, onFrame);
    await client.connect();
    ws.emit('frame', {});
    ws.emit('frame', new Uint8Array(1));
    expect(onFrame).toHaveBeenCalledTimes(2);
    await client.close();
    ws.emit('frame', {});
    expect(onFrame).toHaveBeenCalledTimes(2);
  });
});
