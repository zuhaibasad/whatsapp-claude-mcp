// HostOps over HTTP: talks to the lock holder using service.json and the control token.
import fs from 'node:fs';
import type { ChatRow, KeyringBackend } from '../core/contracts.js';
import type { DataPaths } from '../core/paths.js';
import type { CollectorState, Diagnosis, HostInfo, SelectionSummary, SetupState } from '../core/service.js';
import { napiKeyringBackend } from '../crypto/index.js';
import { readControlToken } from './auth.js';
import { HostError, HostUnavailableError, type HostOps } from './types.js';

export interface HostClientOptions {
  keyring?: KeyringBackend;
  /** Default request timeout. Default 30 s. */
  timeoutMs?: number;
}

export function readHostInfo(paths: DataPaths): HostInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(paths.serviceInfo, 'utf8')) as Partial<HostInfo>;
    if (typeof v.port !== 'number' || typeof v.pid !== 'number') return null;
    return v as HostInfo;
  } catch {
    return null;
  }
}

export function createHostClient(paths: DataPaths, opts: HostClientOptions = {}): HostOps {
  const keyring = opts.keyring ?? napiKeyringBackend();
  const baseTimeout = opts.timeoutMs ?? 30_000;

  async function call<T>(op: string, body: unknown, extra: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
    const info = readHostInfo(paths);
    if (!info) throw new HostUnavailableError('the wa-bridge collector is not running (no service info)');
    let token: string | null;
    try {
      token = readControlToken(paths, keyring);
    } catch {
      throw new HostUnavailableError('cannot read the control token from the OS keychain');
    }
    if (!token) throw new HostUnavailableError('no control token in the OS keychain');
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${info.port}/api/${op}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra.headers },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(extra.timeoutMs ?? baseTimeout),
      });
    } catch {
      throw new HostUnavailableError();
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // empty or non-JSON body
    }
    if (!res.ok) {
      const m = (json as { error?: unknown } | null)?.error;
      throw new HostError(res.status, typeof m === 'string' ? m : `request failed (${res.status})`);
    }
    return json as T;
  }

  return {
    state: () => call<SetupState>('state', {}),
    acceptRisk: (nonce) => call<SetupState>('accept_risk', {}, nonce ? { headers: { 'X-Accept-Nonce': nonce } } : {}),
    startLink: () => call<SetupState>('start_link', {}),
    cancelLink: () => call<SetupState>('cancel_link', {}),
    chatRows: () => call<ChatRow[]>('chat_rows', {}),
    submitSelection: (selectedIds) => call<SelectionSummary | null>('submit_selection', { selectedIds }),
    waitForSync: (timeoutMs) =>
      call<{ collector: CollectorState; waitedMs: number }>('wait_for_sync', { timeoutMs }, { timeoutMs: timeoutMs + 10_000 }),
    disconnect: ({ keepData, nonce }) =>
      call<SetupState>('disconnect', { keepData }, { headers: nonce ? { 'X-Disconnect-Nonce': nonce } : {}, timeoutMs: 120_000 }),
    diagnose: () => call<Diagnosis>('diagnose', {}),
    mintNonce: (kind) => call<{ nonce: string }>('mint-nonce', { kind: kind ?? 'accept' }),
    openSetup: (screen) => call<{ opened: true }>('open-setup', { screen: screen ?? 'auto' }),
  };
}
