import fs from 'node:fs';
import { resolvePaths } from '../../core/paths.js';
import type { CliDeps } from '../deps.js';
import { CliError, type Io } from '../io.js';
import { requireInitialised } from '../open.js';

export async function linkCommand(opts: { project: string }, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  requireInitialised(paths);

  let shown = false;
  try {
    const res = await deps.linkAccount({
      projectRoot: paths.projectRoot,
      onStatus: (msg) => io.out(msg),
      onQr: async (qr) => {
        io.out(await deps.renderQr(qr));
        await deps.writeQrPng(paths.qrPng, qr);
        if (!shown) {
          shown = true;
          io.out('WhatsApp -> Settings -> Linked devices -> Link a device. Scan within ~60s.');
          io.out(`The code is also saved as ${paths.qrPng}; it is deleted after linking.`);
        } else {
          io.out('(new code, the previous one expired)');
        }
      },
    });
    io.out(`Linked: ${res.id}${res.pushName ? ` (${res.pushName})` : ''}`);
    io.out('Start the daemon: wa-bridge daemon start');
    return 0;
  } catch (e) {
    if (deps.isAlreadyLinkedError(e)) {
      io.out('Already linked. To link a different account run: wa-bridge unlink');
      return 0;
    }
    throw e instanceof Error ? new CliError(e.message) : e;
  } finally {
    try {
      fs.rmSync(paths.qrPng, { force: true });
    } catch {
      /* best effort */
    }
  }
}
