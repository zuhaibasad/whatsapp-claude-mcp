import { resolvePaths } from '../../core/paths.js';
import { buildDiagnosis } from '../../host/diagnose.js';
import type { CliDeps } from '../deps.js';
import type { Io } from '../io.js';
import { openStore } from '../open.js';

/** `chatai doctor`: prints the same health checks as whatsapp_status {diagnose:true}. No secrets, no message text. */
export async function doctorCommand(opts: { project: string; json?: boolean }, io: Io, deps: CliDeps): Promise<number> {
  const paths = resolvePaths(opts.project);
  let keyPresent: boolean | null;
  try { keyPresent = deps.keyStore(paths.projectRoot).get() !== null; } catch { keyPresent = null; }

  let meta: ((k: string) => string | null) | null = null;
  let link: string | null = null;
  let close = (): void => undefined;
  if (keyPresent) {
    try {
      const opened = openStore(paths, deps, { write: false });
      close = opened.close;
      const store = opened.store;
      meta = (k) => store.getMeta(k);
      link = store.getAccount()?.linkStatus ?? null;
    } catch {
      meta = null;
    }
  }
  try {
    const d = buildDiagnosis({
      paths,
      version: '0.3.0',
      now: deps.now,
      keyPresent,
      meta,
      linkStatus: link,
      collector: meta ? ((meta('collector_state') as never) ?? null) : null,
    });
    if (opts.json) {
      io.out(JSON.stringify(d, null, 2));
    } else {
      io.out(`ChatAI health check (data folder: ${d.dataDir})`);
      for (const c of d.checks) {
        io.out(`  [${c.ok ? 'ok' : 'WARN'}] ${c.name}: ${c.detail}`);
        if (!c.ok && c.fix) io.out(`         fix: ${c.fix}`);
      }
    }
    return d.checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    close();
  }
}
