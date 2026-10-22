#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { daemonPhase3Command, daemonStartCommand, daemonStopCommand } from './commands/daemon.js';
import { initCommand } from './commands/init.js';
import { exportCommand, itemsCommand, itemStatusCommand } from './commands/items.js';
import { linkCommand } from './commands/link.js';
import { mcpCommand } from './commands/mcp.js';
import { chatsCommand, newCommand, purgeCommand, searchCommand } from './commands/read.js';
import { registerChatSelection } from './commands/select.js';
import { statusCommand } from './commands/status.js';
import { doctorCommand } from './commands/doctor.js';
import { unlinkCommand } from './commands/unlink.js';
import { defaultDeps, type CliDeps } from './deps.js';
import { CliError, realIo, type Io } from './io.js';

export function buildProgram(io: Io, deps: CliDeps, setExit: (code: number) => void): Command {
  const program = new Command();
  program
    .name('wa-bridge')
    .description('Read-only local WhatsApp bridge for Claude')
    .option('--project <dir>', 'project folder that holds .wa-bridge/', process.cwd());
  const project = (): string => program.opts<{ project: string }>().project;

  const run = (fn: () => Promise<number> | number) => async (): Promise<void> => {
    try {
      setExit(await fn());
    } catch (e) {
      if (e instanceof CliError) {
        io.err(e.message);
        setExit(e.code);
      } else {
        io.err(e instanceof Error ? e.message : String(e));
        setExit(1);
      }
    }
  };

  program.command('init')
    .description('create .wa-bridge/, the encryption key and default config (asks you to accept the risks)')
    .option('--accept', 'non-interactive; also requires env WA_BRIDGE_ACCEPT_RISK="I accept"')
    .action((o: { accept?: boolean }) => run(() => initCommand({ project: project(), accept: o.accept }, io, deps))());

  program.command('link')
    .description('link your WhatsApp account by scanning a QR code')
    .action(() => run(() => linkCommand({ project: project() }, io, deps))());

  const daemon = program.command('daemon').description('run or control the background collector');
  daemon.command('start')
    .description('start the daemon (foreground unless --detach)')
    .option('--detach', 'run in the background')
    .action((o: { detach?: boolean }) => run(() => daemonStartCommand({ project: project(), detach: o.detach }, io, deps))());
  daemon.command('stop').description('stop the running daemon')
    .action(() => run(() => daemonStopCommand({ project: project() }, io, deps))());
  daemon.command('install').description('install as a login service (Phase 3)')
    .action(() => run(() => daemonPhase3Command('install', io))());
  daemon.command('uninstall').description('remove the login service (Phase 3)')
    .action(() => run(() => daemonPhase3Command('uninstall', io))());

  program.command('status')
    .description('show link, daemon and sync status')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => run(() => statusCommand({ project: project(), json: o.json }, io, deps))());

  const chats = program.command('chats')
    .description('list chats with unreviewed counts')
    .option('--all', 'include chats that are excluded by the filter')
    .option('--direct', 'direct chats only')
    .option('--groups', 'groups only')
    .option('--active-since <when>', 'only chats active since e.g. 7d')
    .option('--json', 'machine-readable output')
    .action((o: { all?: boolean; direct?: boolean; groups?: boolean; activeSince?: string; json?: boolean }) =>
      run(() => chatsCommand({ project: project(), ...o }, io, deps))());
  registerChatSelection(chats, run, project, io, deps);

  program.command('new')
    .description('show new messages grouped by chat')
    .option('--since <when>', 'ISO time, duration like 7d, or last_review', 'last_review')
    .option('--limit <n>', 'maximum messages', '200')
    .option('--json', 'machine-readable output')
    .action((o: { since?: string; limit?: string; json?: boolean }) =>
      run(() => newCommand({ project: project(), ...o }, io, deps))());

  program.command('search')
    .description('full-text search stored messages')
    .argument('<query>', 'search text')
    .option('--chat <id|name>', 'restrict to one chat')
    .option('--since <when>', 'ISO time or duration like 7d')
    .option('--limit <n>', 'maximum hits', '50')
    .option('--json', 'machine-readable output')
    .action((q: string, o: { chat?: string; since?: string; limit?: string; json?: boolean }) =>
      run(() => searchCommand(q, { project: project(), ...o }, io, deps))());

  program.command('purge')
    .description('delete stored messages older than a duration')
    .requiredOption('--older-than <duration>', 'e.g. 30d, 12h, 90m')
    .action((o: { olderThan: string }) => run(() => purgeCommand({ project: project(), olderThan: o.olderThan }, io, deps))());

  const items = program.command('items')
    .description('list saved follow-up items')
    .option('--status <status>', 'open, done or dismissed')
    .option('--department <name>', 'only this department')
    .option('--priority <priority>', 'critical, high, normal or low')
    .option('--json', 'machine-readable output')
    .action((o: { status?: string; department?: string; priority?: string; json?: boolean }) =>
      run(() => itemsCommand({ project: project(), ...o }, io, deps))());
  items.command('done').description('mark an item done').argument('<id>', 'item id')
    .action((id: string) => run(() => itemStatusCommand(id, 'done', { project: project() }, io, deps))());
  items.command('dismiss').description('dismiss an item').argument('<id>', 'item id')
    .action((id: string) => run(() => itemStatusCommand(id, 'dismissed', { project: project() }, io, deps))());

  program.command('export')
    .description('write saved items to a CSV or JSON file inside the project folder')
    .option('--format <format>', 'csv or json', 'csv')
    .option('--path <file>', 'target file inside the project folder')
    .option('--status <status>', 'open, done or dismissed', 'open')
    .action((o: { format?: string; path?: string; status?: string }) =>
      run(() => exportCommand({ project: project(), ...o }, io, deps))());

  program.command('mcp')
    .description('run the MCP server on stdio (for Claude)')
    .action(() => run(() => mcpCommand({ project: project() }, io, deps))());

  program.command('doctor')
    .description('check the data folder, key, connection and disk, with plain-language fixes')
    .option('--json', 'machine-readable output')
    .action((o: { json?: boolean }) => run(() => doctorCommand({ project: project(), json: o.json }, io, deps))());

  program.command('unlink')
    .description('remove the linked device from WhatsApp and delete the local session')
    .option('--keep-data', 'keep stored messages, settings and the keychain key')
    .action((o: { keepData?: boolean }) => run(() => unlinkCommand({ project: project(), keepData: o.keepData }, io, deps))());

  return program;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href) {
  const program = buildProgram(realIo(), defaultDeps(), (c) => {
    process.exitCode = c;
  });
  await program.parseAsync(process.argv);
}
