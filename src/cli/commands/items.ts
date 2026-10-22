import { loadConfig } from '../../config/index.js';
import type { ItemPriority, ItemStatus } from '../../core/types.js';
import { resolvePaths } from '../../core/paths.js';
import { ExportError, itemRow, writeItemsExport, type ExportFormat } from '../../export/index.js';
import type { CliDeps } from '../deps.js';
import { formatTs, oneLine, table, truncate } from '../format.js';
import { CliError, type Io } from '../io.js';
import { openStore } from '../open.js';

const STATUSES: ItemStatus[] = ['open', 'done', 'dismissed'];
const PRIORITIES: ItemPriority[] = ['critical', 'high', 'normal', 'low'];

function pick<T extends string>(v: string | undefined, allowed: T[], flag: string): T | undefined {
  if (v === undefined) return undefined;
  if (!(allowed as string[]).includes(v)) throw new CliError(`Invalid ${flag} "${v}". Use one of: ${allowed.join(', ')}.`);
  return v as T;
}

export interface ItemsOpts {
  project: string;
  status?: string;
  department?: string;
  priority?: string;
  json?: boolean;
}

export async function itemsCommand(opts: ItemsOpts, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  const status = pick(opts.status, STATUSES, '--status');
  const priority = pick(opts.priority, PRIORITIES, '--priority');
  const { config } = loadConfig(paths);
  const nowSec = Math.floor(deps.now() / 1000);
  const { store, close } = openStore(paths, deps, { write: false });
  try {
    const items = store.listItems({ status, priority, department: opts.department });
    if (opts.json) {
      io.out(JSON.stringify(items.map((i) => itemRow(i, nowSec, config.timezone)), null, 2));
      return 0;
    }
    if (items.length === 0) {
      io.out('No items.');
      return 0;
    }
    io.out(table(
      ['ID', 'STATUS', 'PRIORITY', 'CATEGORY', 'DEPARTMENT', 'CHAT', 'SUMMARY', 'CREATED'],
      items.map((i) => [
        String(i.id), i.status, i.priority, i.category, i.department ?? '-', truncate(i.chatName ?? '-', 24),
        truncate(oneLine(i.summary), 60), formatTs(i.createdAt, config.timezone),
      ]),
    ));
    return 0;
  } finally {
    close();
  }
}

/** `items done <id>` / `items dismiss <id>`. Changes only our own store. */
export async function itemStatusCommand(
  id: string, status: 'done' | 'dismissed', opts: { project: string }, io: Io, deps: CliDeps,
): Promise<number> {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`Invalid item id "${id}".`);
  const { store, close } = openStore(resolvePaths(opts.project), deps, { write: true });
  try {
    const it = store.updateItem(n, status);
    if (!it) throw new CliError(`No item with id ${n}. See: chatai items`);
    io.out(`Item ${it.id} marked ${it.status}.`);
    return 0;
  } finally {
    close();
  }
}

export interface ExportOpts {
  project: string;
  format?: string;
  path?: string;
  status?: string;
}

export async function exportCommand(opts: ExportOpts, io: Io, deps: CliDeps): Promise<number> {
  const format = opts.format ?? 'csv';
  if (format !== 'csv' && format !== 'json') throw new CliError(`Invalid --format "${format}". Use csv or json.`);
  const status = pick(opts.status ?? 'open', STATUSES, '--status');
  const paths = resolvePaths(opts.project);
  const { config } = loadConfig(paths);
  const { store, close } = openStore(paths, deps, { write: false });
  try {
    const items = store.listItems({ status });
    const res = writeItemsExport({
      paths, items, format: format as ExportFormat, path: opts.path, nowMs: deps.now(), timezone: config.timezone,
    });
    io.out(`Exported ${res.count} item${res.count === 1 ? '' : 's'} to ${res.path}`);
    return 0;
  } catch (e) {
    if (e instanceof ExportError) throw new CliError(e.message);
    throw e;
  } finally {
    close();
  }
}
