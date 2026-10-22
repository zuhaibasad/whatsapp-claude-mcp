// Local control server (lock holder only): 127.0.0.1, random port. Auth, Host and Origin checks on every request.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../core/logger.js';
import type { HostInfo } from '../core/service.js';
import { SessionStore, getOrCreateControlToken, safeEqual } from './auth.js';
import type { HolderCore } from './core.js';
import { HostError, type HostDeps } from './types.js';

const MAX_BODY = 1_000_000;

export interface ControlServer {
  port: number;
  close(): Promise<void>;
}

const PLACEHOLDER_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>wa-bridge setup</title></head>' +
  '<body><p>The wa-bridge setup page has not been built yet.</p></body></html>';

function uiCandidates(deps: HostDeps): string[] {
  if (deps.uiHtmlPath) return [deps.uiHtmlPath];
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, '..', 'ui', 'setup.html'),          // dist/host -> dist/ui
    path.resolve(here, '..', '..', 'dist', 'ui', 'setup.html'), // src/host -> dist/ui
    path.resolve(here, 'ui', 'setup.html'),                // single-file bundle next to the entry
  ];
}

function loadUiHtml(deps: HostDeps): string {
  for (const f of uiCandidates(deps)) {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      // try the next one
    }
  }
  return PLACEHOLDER_HTML;
}

function injectGlobals(html: string, csrf: string): string {
  const tag = `<script>window.__WA_HTTP__=${JSON.stringify({ csrf })};</script>`;
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  return tag + html;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HostError(413, 'request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HostError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export async function startControlServer(
  core: HolderCore,
  paths: { serviceInfo: string; projectRoot: string },
  deps: HostDeps,
  logger: Logger,
  controlTokenPaths: Parameters<typeof getOrCreateControlToken>[0],
): Promise<ControlServer> {
  const token = getOrCreateControlToken(controlTokenPaths, deps.keyring);
  const sessions = new SessionStore(deps.now);
  let port = 0;
  const cookieName = (): string => `wab_${port}`;

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(text);
  };
  const deny = (res: http.ServerResponse, status: number, why: string): void => {
    logger.warn({ why }, 'request rejected');
    send(res, status, { error: status === 401 ? 'unauthorized' : 'forbidden' });
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.headers.host !== `127.0.0.1:${port}`) return deny(res, 403, 'bad host');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const route = url.pathname;

    if (req.method === 'GET') {
      if (route === '/api/health') return send(res, 200, { ok: true, version: deps.version });
      if (route === '/setup') {
        const t = url.searchParams.get('t');
        if (t !== null) {
          if (!core.browserTokens.consume(t)) return deny(res, 403, 'bad browser token');
          const { id } = sessions.create();
          res.writeHead(302, {
            Location: '/setup',
            'Set-Cookie': `${cookieName()}=${id}; HttpOnly; SameSite=Strict; Path=/`,
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        const session = sessions.get(parseCookies(req.headers.cookie).get(cookieName()));
        if (!session) return deny(res, 401, 'no session');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(injectGlobals(loadUiHtml(deps), session.csrf));
        return;
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method !== 'POST' || !route.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) return deny(res, 403, 'bad origin');

    // Who is calling?
    const auth = req.headers.authorization;
    const isControl = typeof auth === 'string' && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), token);
    let isSession = false;
    if (!isControl) {
      const session = sessions.get(parseCookies(req.headers.cookie).get(cookieName()));
      const csrf = req.headers['x-csrf'];
      if (session && origin !== undefined && typeof csrf === 'string' && safeEqual(csrf, session.csrf)) isSession = true;
    }
    if (!isControl && !isSession) return deny(res, 401, 'no credentials');

    const op = route.slice('/api/'.length);
    const body = (await readBody(req)) as Record<string, unknown>;
    try {
      switch (op) {
        case 'state':
          return send(res, 200, await core.state());
        case 'accept_risk': {
          const nonce = req.headers['x-accept-nonce'];
          const proved = isSession || core.nonces.consume(typeof nonce === 'string' ? nonce : undefined);
          if (!proved) return deny(res, 403, 'accept_risk needs a session or a nonce');
          return send(res, 200, await core.acceptVerified());
        }
        case 'start_link':
          return send(res, 200, await core.startLink());
        case 'cancel_link':
          return send(res, 200, await core.cancelLink());
        case 'chat_rows':
          return send(res, 200, await core.chatRows());
        case 'submit_selection': {
          const ids = body.selectedIds;
          if (ids !== null && ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === 'string'))) {
            throw new HostError(400, 'selectedIds must be a list of strings or null');
          }
          return send(res, 200, await core.submitSelection((ids as string[] | null | undefined) ?? null));
        }
        case 'wait_for_sync': {
          const ms = typeof body.timeoutMs === 'number' && body.timeoutMs >= 0 ? Math.min(body.timeoutMs, 600_000) : 30_000;
          return send(res, 200, await core.waitForSync(ms));
        }
        case 'mint-nonce':
          if (!isControl) return deny(res, 403, 'control token required');
          return send(res, 200, await core.mintNonce());
        case 'open-setup':
          if (!isControl) return deny(res, 403, 'control token required');
          return send(res, 200, await core.openSetup());
        default:
          return send(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (err instanceof HostError) return send(res, err.status, { error: err.message });
      logger.error({ op, err: err instanceof Error ? err.message : String(err) }, 'op failed');
      return send(res, 500, { error: 'internal error' });
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HostError) return send(res, err.status, { error: err.message });
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'request failed');
      send(res, 500, { error: 'internal error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  core.setPort(port);

  const info: HostInfo = { pid: process.pid, port, version: deps.version, startedAt: Math.floor(deps.now() / 1000) };
  const tmp = `${paths.serviceInfo}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(info));
  fs.renameSync(tmp, paths.serviceInfo);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          const raw = fs.readFileSync(paths.serviceInfo, 'utf8');
          if ((JSON.parse(raw) as HostInfo).pid === process.pid) fs.rmSync(paths.serviceInfo, { force: true });
        } catch {
          // already gone
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
