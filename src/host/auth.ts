// Credentials for the local control server. Secrets are never logged and never returned toward the model.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { KEYCHAIN_SERVICE } from '../core/constants.js';
import type { KeyringBackend } from '../core/contracts.js';
import type { DataPaths } from '../core/paths.js';
import { SERVICE_TOKEN_SUFFIX } from '../core/service.js';
import { keychainAccountId } from '../crypto/index.js';

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newSecret = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Constant-time string comparison (compares digests, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function tokenAccount(paths: DataPaths): string {
  return `${keychainAccountId(paths.projectRoot)}${SERVICE_TOKEN_SUFFIX}`;
}

/** Reads the control token from the OS keychain; null if none exists. */
export function readControlToken(paths: DataPaths, keyring: KeyringBackend): string | null {
  return keyring.getPassword(KEYCHAIN_SERVICE, tokenAccount(paths));
}

/** Reads the control token, creating it if missing. */
export function getOrCreateControlToken(paths: DataPaths, keyring: KeyringBackend): string {
  const existing = readControlToken(paths, keyring);
  if (existing) return existing;
  const token = newSecret(32);
  keyring.setPassword(KEYCHAIN_SERVICE, tokenAccount(paths), token);
  return token;
}

/** Single-use secrets with a TTL. Only the hash is kept. */
export class OneTimeStore {
  private readonly items = new Map<string, number>(); // hash -> expiry (ms)

  constructor(private readonly now: () => number = Date.now) {}

  mint(ttlMs: number): string {
    this.prune();
    const secret = newSecret(24);
    this.items.set(sha256Hex(secret), this.now() + ttlMs);
    return secret;
  }

  /** True once if the secret is valid; it is consumed either way. */
  consume(secret: string | undefined | null): boolean {
    if (!secret) return false;
    const h = sha256Hex(secret);
    const exp = this.items.get(h);
    if (exp === undefined) return false;
    this.items.delete(h);
    return exp > this.now();
  }

  private prune(): void {
    const t = this.now();
    for (const [h, exp] of this.items) if (exp <= t) this.items.delete(h);
  }
}

export interface BrowserSession {
  csrf: string;
  expires: number;
}

/** Browser sessions (HttpOnly cookie + CSRF header). */
export class SessionStore {
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 8 * 3_600_000) {}

  create(): { id: string; session: BrowserSession } {
    const t = this.now();
    for (const [id, s] of this.sessions) if (s.expires <= t) this.sessions.delete(id);
    const id = newSecret(32);
    const session = { csrf: newSecret(24), expires: t + this.ttlMs };
    this.sessions.set(id, session);
    return { id, session };
  }

  get(id: string | undefined): BrowserSession | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expires <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }
}
