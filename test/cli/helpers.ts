import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MasterKeyStore, WaClient, WaClientEvents } from '../../src/core/contracts.js';
import type { MessageInput } from '../../src/core/types.js';
import { createMasterKeyStore } from '../../src/crypto/index.js';
import type { CliDeps } from '../../src/cli/deps.js';
import type { Io } from '../../src/cli/io.js';
import { openStore } from '../../src/cli/open.js';
import { resolvePaths } from '../../src/core/paths.js';

export function fakeIo(answers: string[] = []): Io & { outs: string[]; errs: string[]; text(): string } {
  const outs: string[] = [];
  const errs: string[] = [];
  const queue = [...answers];
  return {
    outs, errs,
    out: (s) => void outs.push(s),
    err: (s) => void errs.push(s),
    prompt: async (q) => {
      outs.push(q);
      return queue.shift() ?? '';
    },
    text: () => outs.join('\n'),
  };
}

export function tmpProject(): { dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-cli-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export interface FakeClient extends WaClient {
  calls: string[];
  emit<E extends keyof WaClientEvents>(e: E, ...a: Parameters<WaClientEvents[E]>): void;
}

export function fakeClient(opts: { opens?: boolean } = {}): FakeClient {
  const listeners: Record<string, ((...a: never[]) => void)[]> = {};
  const calls: string[] = [];
  const c: FakeClient = {
    calls,
    on: (e, l) => void (listeners[e] ??= []).push(l as (...a: never[]) => void),
    emit: (e, ...a) => (listeners[e] ?? []).forEach((l) => (l as (...x: unknown[]) => void)(...a)),
    connect: async () => {
      calls.push('connect');
      if (opts.opens !== false) {
        queueMicrotask(() => c.emit('connection', { state: 'open', me: { id: 'me@s.whatsapp.net', lid: null, pushName: null } }));
      }
    },
    close: async () => void calls.push('close'),
    unlink: async () => void calls.push('unlink'),
  };
  return c;
}

export function fakeDeps(over: Partial<CliDeps> = {}): CliDeps & { keys: Map<string, string> } {
  const map = new Map<string, string>();
  const backend = {
    getPassword: (s: string, a: string) => map.get(`${s}|${a}`) ?? null,
    setPassword: (s: string, a: string, p: string) => void map.set(`${s}|${a}`, p),
    deletePassword: (s: string, a: string) => map.delete(`${s}|${a}`),
  };
  const stores = new Map<string, MasterKeyStore>();
  return {
    keys: map,
    keyStore: (root) => {
      let s = stores.get(root);
      if (!s) stores.set(root, (s = createMasterKeyStore(root, backend)));
      return s;
    },
    now: () => Date.now(),
    linkAccount: async () => ({ id: '111@s.whatsapp.net', pushName: 'Me' }),
    isAlreadyLinkedError: (e) => e instanceof Error && e.name === 'AlreadyLinkedError',
    runDaemon: async () => ({ stop: async () => undefined }),
    waitForShutdown: async () => undefined,
    spawnDetached: () => 4242,
    killPid: () => undefined,
    sleep: async () => undefined,
    createClient: () => fakeClient(),
    renderQr: async (qr) => `QR[${qr}]`,
    writeQrPng: async (file) => void fs.writeFileSync(file, 'png'),
    unlinkOpenTimeoutMs: 200,
    ...over,
  };
}

export function msg(over: Partial<MessageInput> & { id: string; chatId: string; ts: number }): MessageInput {
  return {
    senderId: 'alice@s.whatsapp.net', senderName: 'Alice', text: 'hello', quotedId: null, quotedSenderId: null,
    mentions: [], mentionReason: null, isFromMe: false, hasMedia: false, mediaType: null, ...over,
  };
}

/** Writes messages through the real store (project must be initialised). */
export function seed(project: string, deps: CliDeps, msgs: MessageInput[]): void {
  const { store, close } = openStore(resolvePaths(project), deps, { write: true });
  try {
    for (const m of msgs) store.insertMessage(m);
  } finally {
    close();
  }
}
