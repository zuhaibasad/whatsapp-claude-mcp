import fs from 'node:fs';
import path from 'node:path';
import { pino, type Logger } from 'pino';

// Logs carry event names and ids only. Never pass message text or key material to a logger.
export function createLogger(opts: { level?: string; file?: string; name?: string } = {}): Logger {
  const level = opts.level ?? 'info';
  if (!opts.file) return pino({ level, name: opts.name, base: undefined });
  fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  return pino({ level, name: opts.name, base: undefined }, pino.destination({ dest: opts.file, sync: false, mkdir: true }));
}

export type { Logger };
