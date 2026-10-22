// Usage: node scripts/dev/accept-flow.mjs <unpacked-mcpb-dir> <temp-data-dir>
// Drives the packaged MCP server like the Desktop panel does, up to risk acceptance (no WhatsApp contact).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [pkg, dataDir] = process.argv.slice(2);
fs.mkdirSync(dataDir, { recursive: true });
const child = spawn(process.execPath, [path.join(pkg, 'dist', 'mcp', 'main.js'), '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiting = new Map();
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  }
});
let id = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const my = ++id; waiting.set(my, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  setTimeout(() => rej(new Error('timeout ' + method)), 30000);
});
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const check = (label, ok, extra = '') => console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'accept-flow', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const s0 = await call('setup_state');
check('initial step is needs_accept', s0.result?.structuredContent?.step === 'needs_accept', s0.result?.structuredContent?.step);

const bad = await call('setup_accept_risk', { nonce: 'not-a-real-nonce' });
check('accept with a fake nonce is refused', bad.result?.isError === true);

const res = await rpc('resources/read', { uri: 'ui://chatai/setup.html' });
const html = res.result.contents[0].text;
const nonce = html.match(/__WA_NONCE__="([^"]+)"/)?.[1];
check('panel HTML carries a nonce', !!nonce);

const open = await call('whatsapp_setup');
const openText = JSON.stringify(open.result);
check('open_setup result has no nonce/token', nonce && !openText.includes(nonce) && !/[?&]t=/.test(openText));

const ok = await call('setup_accept_risk', { nonce });
check('accept with the panel nonce works', ok.result?.structuredContent?.step === 'ready_to_link', ok.result?.structuredContent?.step ?? JSON.stringify(ok.result).slice(0, 200));
const okText = ok.result?.content?.map((c) => c.text).join(' ') ?? '';
check('accept result text has no nonce', !okText.includes(nonce));

const replay = await call('setup_accept_risk', { nonce });
check('replaying the same nonce is refused (or a no-op on already-accepted)', replay.result?.isError === true || replay.result?.structuredContent?.step === 'ready_to_link', replay.result?.isError ? 'refused' : 'no-op');

const st = await call('whatsapp_status');
const stText = JSON.stringify(st.result);
check('get_status has no qrSvg', !stText.includes('qrSvg') && !stText.includes('<svg'));
console.log('status:', st.result.content[0].text.slice(0, 300));

child.stdin.end();
setTimeout(() => process.exit(0), 1500);
