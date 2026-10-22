// Non-interactive chat selection: `chatai chats select|include|exclude`.
import type { Command } from 'commander';
import { loadConfig } from '../../config/index.js';
import { computeRules, currentSelection, writeSelection, type ChatChoice } from '../../config/selection.js';
import { resolvePaths } from '../../core/paths.js';
import { readLock } from '../../daemon/lock.js';
import type { CliDeps } from '../deps.js';
import { truncate } from '../format.js';
import { CliError, type Io } from '../io.js';
import { openStore } from '../open.js';

export type TypeSetting = 'all' | 'none';

export interface SelectOpts {
  project: string;
  all?: boolean;
  none?: boolean;
  groups?: string;
  direct?: string;
  channels?: string;
  include?: string[];
  exclude?: string[];
}

const label = (c: ChatChoice): string => `${c.name ?? '(no name)'} [${c.id}]`;

/** Resolves a user argument: exact id, else exact name (case-insensitive), else unique substring of name or id. */
export function resolveChat(arg: string, all: ChatChoice[]): ChatChoice {
  const needle = arg.trim().toLowerCase();
  if (needle === '') throw new CliError('Empty chat name.');
  const byId = all.find((c) => c.id.toLowerCase() === needle);
  if (byId) return byId;
  const exact = all.filter((c) => (c.name ?? '').trim().toLowerCase() === needle);
  const pick = (found: ChatChoice[]): ChatChoice | null => {
    if (found.length === 1) return found[0] ?? null;
    if (found.length > 1) {
      throw new CliError(
        `"${arg}" matches ${found.length} chats, be more specific or use the id:\n` +
          found.slice(0, 20).map((c) => `  ${label(c)}`).join('\n'),
      );
    }
    return null;
  };
  const e = pick(exact);
  if (e) return e;
  const sub = pick(all.filter((c) => (c.name ?? '').toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)));
  if (sub) return sub;
  throw new CliError(`No chat matches "${arg}". See: chatai chats --all`);
}

function parseSetting(flag: string, v: string | undefined): TypeSetting | undefined {
  if (v === undefined) return undefined;
  if (v === 'all' || v === 'none') return v;
  throw new CliError(`${flag} must be "all" or "none", not "${v}".`);
}

export async function selectCommand(opts: SelectOpts, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  const groups = parseSetting('--groups', opts.groups);
  const direct = parseSetting('--direct', opts.direct);
  const channels = parseSetting('--set-channels', opts.channels);
  if (opts.all && opts.none) throw new CliError('Use either --all or --none, not both.');
  const include = opts.include ?? [];
  const exclude = opts.exclude ?? [];
  const changing = Boolean(opts.all || opts.none || groups || direct || channels || include.length || exclude.length);

  const { config } = loadConfig(paths);
  const { store, close } = openStore(paths, deps, { write: false });
  let all: ChatChoice[];
  try {
    all = store.listChats({}).map((c) => ({ id: c.id, name: c.name, type: c.type }));
  } finally {
    close();
  }
  const before = currentSelection(config, all);
  const count = (set: Set<string>, type: string): number => all.filter((c) => c.type === type && set.has(c.id)).length;
  const total = (type: string): number => all.filter((c) => c.type === type).length;
  const summary = (set: Set<string>): string =>
    `${count(set, 'group')}/${total('group')} groups, ${count(set, 'direct')}/${total('direct')} direct chats, ${count(set, 'channel')}/${total('channel')} channels`;

  if (!changing) {
    io.out(`Currently selected: ${summary(before)}.`);
    io.out('Change it with: chatai chats select --all | --none | --set-groups all|none | --set-direct all|none | --set-channels all|none, or chats include/exclude <name|id>...');
    return 0;
  }

  const next = new Set(before);
  if (opts.all) all.forEach((c) => next.add(c.id));
  if (opts.none) next.clear();
  for (const [type, setting] of [['group', groups], ['direct', direct], ['channel', channels]] as const) {
    if (!setting) continue;
    for (const c of all) {
      if (c.type !== type) continue;
      if (setting === 'all') next.add(c.id);
      else next.delete(c.id);
    }
  }
  const added = include.map((a) => resolveChat(a, all));
  const removed = exclude.map((a) => resolveChat(a, all));
  added.forEach((c) => next.add(c.id));
  removed.forEach((c) => next.delete(c.id));

  const rules = computeRules(all, next, config);
  const res = writeSelection(paths, rules, all);

  const turnedOn = all.filter((c) => next.has(c.id) && !before.has(c.id));
  const turnedOff = all.filter((c) => !next.has(c.id) && before.has(c.id));
  io.out(`Selected now: ${summary(next)} (was ${summary(before)}).`);
  const show = (title: string, list: ChatChoice[]): void => {
    if (list.length === 0) return;
    io.out(`${title} (${list.length}): ${list.slice(0, 10).map((c) => truncate(c.name ?? c.id, 30)).join(', ')}${list.length > 10 ? ', ...' : ''}`);
  };
  show('Turned on', turnedOn);
  show('Turned off', turnedOff);
  if (turnedOn.length === 0 && turnedOff.length === 0) io.out('No change.');
  io.out(`New chats: groups ${rules.includeGroups ? 'included' : 'excluded'}, direct chats ${rules.includeDirectChats ? 'included' : 'excluded'}, channels ${rules.includeChannels ? 'included' : 'excluded'} by default.`);
  io.out(`Saved to ${res.file}.`);
  if (turnedOn.length > 0) io.out('Note: a chat that is turned on only captures new messages from now on; its history is not downloaded again.');
  const lock = readLock(paths.lockFile);
  if (lock?.alive) io.out('The daemon applies this within about 30 seconds.');
  return 0;
}

/** Adds `select`, `include` and `exclude` under the `chats` command. */
export function registerChatSelection(
  chats: Command,
  run: (fn: () => Promise<number> | number) => () => Promise<void>,
  project: () => string,
  io: Io,
  deps: CliDeps,
): void {
  chats.command('select')
    .description('choose which chats are read (non-interactive; no flags shows the current selection)')
    .option('--all', 'select every chat')
    .option('--none', 'select no chat')
    .option('--set-groups <mode>', 'all or none: select or deselect all groups')
    .option('--set-direct <mode>', 'all or none: select or deselect all direct chats')
    .option('--set-channels <mode>', 'all or none: select or deselect all channels')
    .option('--include <chat...>', 'also select these chats (name or id)')
    .option('--exclude <chat...>', 'deselect these chats (name or id)')
    // `--all` is also an option of the parent `chats` listing, which consumes it first; optsWithGlobals sees both.
    .action((_o: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<{ all?: boolean; none?: boolean; setGroups?: string; setDirect?: string; setChannels?: string; include?: string[]; exclude?: string[] }>();
      return run(() => selectCommand({
        project: project(), all: o.all, none: o.none, groups: o.setGroups, direct: o.setDirect, channels: o.setChannels, include: o.include, exclude: o.exclude,
      }, io, deps))();
    });
  chats.command('include')
    .description('start reading these chats (name or id)')
    .argument('<chat...>', 'chat names or ids')
    .action((names: string[]) => run(() => selectCommand({ project: project(), include: names }, io, deps))());
  chats.command('exclude')
    .description('stop reading these chats (name or id)')
    .argument('<chat...>', 'chat names or ids')
    .action((names: string[]) => run(() => selectCommand({ project: project(), exclude: names }, io, deps))());
}
