import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR_NAME } from '../../core/constants.js';
import { resolvePaths } from '../../core/paths.js';
import { initDataFiles } from '../../host/init.js';
import type { CliDeps } from '../deps.js';
import { CliError, type Io } from '../io.js';
import { ACCEPT_PHRASE, RISK_WARNING } from '../warning.js';

export interface InitOpts {
  project: string;
  accept?: boolean;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Adds `.chatai/` to <project>/.gitignore once. Returns true if the file changed. */
export function ensureGitignore(projectRoot: string): boolean {
  const file = path.join(projectRoot, '.gitignore');
  const entry = `${DATA_DIR_NAME}/`;
  let text = '';
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, 'utf8');
    const has = text.split(/\r?\n/).some((l) => {
      const t = l.trim();
      return t === entry || t === DATA_DIR_NAME || t === `/${entry}` || t === `/${DATA_DIR_NAME}`;
    });
    if (has) return false;
  }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${text}${sep}${entry}\n`);
  return true;
}

export async function initCommand(opts: InitOpts, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  const env = opts.env ?? process.env;
  const keyStore = deps.keyStore(paths.projectRoot);

  const alreadyInit = fs.existsSync(paths.storeDb) && keyStore.get() !== null;
  if (alreadyInit) {
    ensureGitignore(paths.projectRoot);
    io.out(`Already initialised in ${paths.dataDir}. Nothing changed.`);
    return 0;
  }

  io.out(RISK_WARNING);
  if (opts.accept) {
    if (env['CHATAI_ACCEPT_RISK'] !== ACCEPT_PHRASE) {
      throw new CliError(
        `--accept is only allowed when the environment variable CHATAI_ACCEPT_RISK is set to "${ACCEPT_PHRASE}".`,
      );
    }
  } else {
    const answer = await io.prompt(`Type "${ACCEPT_PHRASE}" to continue: `);
    if (answer.trim() !== ACCEPT_PHRASE) throw new CliError('Aborted: the risks were not accepted.');
  }

  await initDataFiles(paths, keyStore, { riskAcceptedAtMs: deps.now() });
  const changed = ensureGitignore(paths.projectRoot);

  io.out(`Initialised ${paths.dataDir}`);
  io.out(`  encrypted store and session databases created, key saved in the OS keychain`);
  io.out(changed ? `  added ${DATA_DIR_NAME}/ to .gitignore` : `  ${DATA_DIR_NAME}/ already in .gitignore`);
  io.out('');
  io.out('Next steps:');
  io.out('  1. Edit .chatai/config.yaml (your names, which chats to include).');
  io.out('  2. chatai link            link your WhatsApp account (scan the QR code)');
  io.out('  3. chatai daemon start    start collecting messages');
  return 0;
}
