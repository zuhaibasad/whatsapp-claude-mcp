import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Entry } from '@napi-rs/keyring';
import { KEYCHAIN_SERVICE } from '../core/constants.js';
import type { KeyringBackend, MasterKeyStore } from '../core/contracts.js';

export class KeychainUnavailableError extends Error {
  constructor(detail: string, cause?: unknown) {
    const hint =
      process.platform === 'linux'
        ? ' Install and unlock a Secret Service such as gnome-keyring.'
        : '';
    super(`OS keychain is unavailable: ${detail}.${hint}`, { cause });
    this.name = 'KeychainUnavailableError';
  }
}
export class KeyExistsError extends Error {
  constructor() {
    super('A master key already exists for this project.');
    this.name = 'KeyExistsError';
  }
}
export class CorruptKeyError extends Error {
  constructor() {
    super('The stored master key is corrupt (not 32 bytes of base64).');
    this.name = 'CorruptKeyError';
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNoEntry(e: unknown): boolean {
  return /no (matching )?entry|not found|no password|NoEntry|element not found/i.test(errMsg(e));
}

export function napiKeyringBackend(): KeyringBackend {
  return {
    getPassword(service, account) {
      try {
        const v = new Entry(service, account).getPassword();
        return v ?? null;
      } catch (e) {
        if (isNoEntry(e)) return null;
        throw new KeychainUnavailableError(errMsg(e), e);
      }
    },
    setPassword(service, account, password) {
      try {
        new Entry(service, account).setPassword(password);
      } catch (e) {
        throw new KeychainUnavailableError(errMsg(e), e);
      }
    },
    deletePassword(service, account) {
      try {
        return new Entry(service, account).deletePassword();
      } catch (e) {
        if (isNoEntry(e)) return false;
        throw new KeychainUnavailableError(errMsg(e), e);
      }
    },
  };
}

export function keychainAccountId(projectRoot: string): string {
  let p = path.resolve(projectRoot);
  if (process.platform === 'win32') p = p.toLowerCase();
  return 'project-' + createHash('sha256').update(p).digest('hex').slice(0, 16);
}

/** `service` defaults to KEYCHAIN_SERVICE; only tests override it. */
export function createMasterKeyStore(
  projectRoot: string,
  backend: KeyringBackend = napiKeyringBackend(),
  service: string = KEYCHAIN_SERVICE,
): MasterKeyStore {
  const account = keychainAccountId(projectRoot);
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof KeychainUnavailableError) throw e;
      throw new KeychainUnavailableError(errMsg(e), e);
    }
  };
  return {
    get() {
      const v = wrap(() => backend.getPassword(service, account));
      if (v === null) return null;
      const buf = Buffer.from(v, 'base64');
      if (buf.length !== 32 || buf.toString('base64') !== v) throw new CorruptKeyError();
      return buf;
    },
    create() {
      if (wrap(() => backend.getPassword(service, account)) !== null) throw new KeyExistsError();
      const key = randomBytes(32);
      wrap(() => backend.setPassword(service, account, key.toString('base64')));
      return key;
    },
    delete() {
      return wrap(() => backend.deletePassword(service, account));
    },
  };
}
