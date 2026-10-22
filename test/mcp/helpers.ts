import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import type { MessageInput } from '../../src/core/types.js';
import { SqliteStore } from '../../src/store/index.js';
import { createServer, type McpDeps } from '../../src/mcp/server.js';

export const G1 = '111@g.us';
export const G2 = '222@g.us';
export const T0 = 1_760_000_000; // fixed "now" in seconds

let n = 0;
export function msg(o: Partial<MessageInput> = {}): MessageInput {
  n++;
  return {
    id: `m${n}`, chatId: G1, senderId: '923001@s.whatsapp.net', senderName: 'Ali', ts: T0 - 10_000 + n, text: 'hello world',
    quotedId: null, quotedSenderId: null, mentions: [], mentionReason: null, isFromMe: false,
    hasMedia: false, mediaType: null, ...o,
  };
}

export interface Harness {
  store: SqliteStore;
  dir: string;
  deps: McpDeps;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(tool: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }>;
  cleanup(): void;
}

export function harness(over: Partial<McpDeps> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-mcp-'));
  const store = new SqliteStore(new Database(':memory:'));
  store.migrate();
  store.upsertAccount({ id: '923001234567:5@s.whatsapp.net', linkStatus: 'linked' });
  store.upsertChat({ id: G1, type: 'group', name: 'ERP Support 🚀', participantCount: 3 });
  store.upsertChat({ id: G2, type: 'group', name: 'اردو گروپ', participantCount: 2 });
  const deps: McpDeps = {
    projectRoot: dir,
    now: () => T0 * 1000,
    openStore: () => ({ store, close: () => undefined }),
    readLock: () => ({ pid: 1, startedAt: T0 * 1000, alive: true }),
    ...over,
  };
  const { handlers } = createServer(deps);
  return {
    store, dir, deps,
    async call(tool, args = {}) {
      const h = handlers.get(tool);
      if (!h) throw new Error(`no tool ${tool}`);
      const r = await h(args);
      const text = r.content[0]?.text ?? '';
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* error text */
      }
      return { isError: 'isError' in r && r.isError === true, text, json };
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
