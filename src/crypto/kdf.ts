import { hkdfSync } from 'node:crypto';
import type { DbPurpose } from '../core/contracts.js';

const SALT = 'wa-bridge/v1';

/** Derives a 32-byte per-file key from the master key. Deterministic; differs per purpose. */
export function deriveDbKey(master: Buffer, purpose: DbPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', master, SALT, purpose, 32));
}
