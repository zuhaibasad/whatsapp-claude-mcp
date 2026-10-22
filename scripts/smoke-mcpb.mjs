// Smoke test for the packed .mcpb: unpack it, start the MCP server over stdio against a temp data dir,
// and check initialize, tools/list (whatsapp_*) and resources/read of the setup UI. No WhatsApp connection.
// Usage: node scripts/smoke-mcpb.mjs [path/to/file.mcpb]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const file = path.resolve(process.argv[2] ?? path.join(root, 'build', `chatai-${pkg.version}.mcpb`));
if (!fs.existsSync(file)) {
  console.error(`missing ${file}: run npm run build:mcpb first`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-smoke-'));
const unpacked = path.join(tmp, 'ext');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const un = spawnSync(npx, ['--no-install', 'mcpb', 'unpack', file, unpacked], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
if (un.status !== 0) {
  console.error(un.stdout, un.stderr);
  console.error('unpack failed');
  process.exit(1);
}

const hostPresent = fs.existsSync(path.join(unpacked, 'dist', 'host', 'index.js'));
const uiPresent = fs.existsSync(path.join(unpacked, 'dist', 'ui', 'setup.html'));
const failures = [];
const notes = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const child = spawn(process.execPath, [path.join(unpacked, 'dist', 'mcp', 'main.js'), '--data-dir', dataDir], {
  cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
const waiters = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined) waiters.get(m.id)?.(m);
    } catch {
      /* not JSON */
    }
  }
});
let next = 1;
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = next++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
    waiters.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
    clientInfo: { name: 'smoke', version: '0' },
  });
  check(init.result?.serverInfo?.name === 'chatai', 'initialize returns serverInfo chatai');
  check(typeof init.result?.instructions === 'string' && init.result.instructions.length > 100, 'server instructions present');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await request('tools/list');
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  const expected = ['whatsapp_brief', 'whatsapp_status', 'whatsapp_read', 'whatsapp_items', 'whatsapp_mark_reviewed', 'whatsapp_setup', 'whatsapp_choose_chats'];
  check(expected.every((n) => names.includes(n)), 'tools/list includes the 7 whatsapp_* tools');
  check(names.filter((n) => !n.startsWith('setup_')).length === 7, 'exactly 7 model-visible tools');
  check(names.includes('setup_state'), 'app-only tools listed for a client with MCP Apps support');

  const status = await request('tools/call', { name: 'whatsapp_status', arguments: {} });
  check(status.result?.isError !== true, 'whatsapp_status works with no data');

  const res = await request('resources/read', { uri: 'ui://chatai/setup.html' });
  if (res.error || !res.result?.contents?.[0]?.text) {
    if (!hostPresent) {
      notes.push('TOLERATED: dist/host is not in this package (collector host not merged yet), so the nonce cannot be minted and resources/read is not checked.');
      console.log('skip resources/read (no collector host in this build)');
    } else {
      check(false, `resources/read of the setup UI (${res.error?.message ?? 'empty'})`);
    }
  } else {
    const html = res.result.contents[0].text;
    check(res.result.contents[0].mimeType === 'text/html;profile=mcp-app', 'setup UI has the MCP App mime type');
    check(/window\.__WA_NONCE__=/.test(html), 'setup UI has an injected nonce');
    if (!uiPresent) notes.push('TOLERATED: dist/ui/setup.html is not in this package; the placeholder page was served.');
    else check(html.length > 5000, 'setup UI is the real built page');
  }
} catch (e) {
  check(false, `exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  child.stdin.end();
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill();
      r();
    }, 5000);
    child.on('exit', () => {
      clearTimeout(t);
      r();
    });
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const n of notes) console.log(n);
if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length})`);
  if (stderr) console.error(stderr.slice(0, 2000));
  process.exit(1);
}
console.log('\nSMOKE PASSED');
