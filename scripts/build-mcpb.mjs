// Builds build/wa-bridge-<version>.mcpb for Claude Desktop (win32-x64).
// Steps: npm run build -> stage app + license files -> npm ci --omit=dev in the stage -> prune -> mcpb pack.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'build', 'mcpb');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'build', `wa-bridge-${pkg.version}.mcpb`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
}

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (fn(p, e) === 'skip') continue;
    if (e.isDirectory()) walk(p, fn);
  }
}

console.log('1/5 building');
run(npm, ['run', 'build']);

console.log('2/5 staging');
rm(stage);
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'templates'), path.join(stage, 'templates'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
for (const file of ['LICENSE', 'NOTICE']) {
  fs.copyFileSync(path.join(root, file), path.join(stage, file));
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packaging', 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
const icon = path.join(root, 'packaging', 'mcpb', 'icon.png');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(stage, 'icon.png'));

console.log('3/5 installing production dependencies (needs network)');
run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--os=win32', '--cpu=x64'], stage);

console.log('4/5 pruning');
const nm = path.join(stage, 'node_modules');
// better-sqlite3-multiple-ciphers: keep only the win32-x64 prebuild; drop sqlite sources.
const bs = path.join(nm, 'better-sqlite3-multiple-ciphers');
if (fs.existsSync(bs)) {
  rm(path.join(bs, 'deps'));
  rm(path.join(bs, 'src'));
  const pre = path.join(bs, 'prebuilds');
  if (fs.existsSync(pre)) for (const f of fs.readdirSync(pre)) if (!f.startsWith('win32-x64')) rm(path.join(pre, f));
}
rm(path.join(nm, 'node-addon-api'));
// Other platforms' optional native packages, if any slipped in.
for (const scope of fs.existsSync(nm) ? fs.readdirSync(nm).filter((n) => n.startsWith('@')) : []) {
  for (const n of fs.readdirSync(path.join(nm, scope))) {
    if (/-(darwin|linux|freebsd|android|openharmony|wasm32)/.test(n) || /win32-(arm64|ia32)/.test(n)) rm(path.join(nm, scope, n));
  }
}
const junkDir = /^(test|tests|__tests__|docs?|examples?|\.github|benchmarks?)$/i;
// Only documentation files: a code file that happens to be named history.js or readme.js must survive. LICENSE files are kept (MIT requires them).
const junkFile = /\.(md|markdown|map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$|^(CHANGELOG|HISTORY|README)(\.(md|markdown|txt|rst))?$/i;
walk(nm, (p, e) => {
  const insideCode = /[\\/](dist|lib|build|src|esm|cjs)[\\/]/.test(p); // never prune runtime code folders (e.g. yaml/dist/doc)
  if (e.isDirectory() && junkDir.test(e.name) && !insideCode) {
    rm(p);
    return 'skip';
  }
  if (e.isFile() && junkFile.test(e.name)) rm(p);
  return undefined;
});
// The stage does not need the lockfile or dev scripts any more.
rm(path.join(stage, 'package-lock.json'));

console.log('5/5 packing');
run(npx, ['--no-install', 'mcpb', 'pack', stage, out]);
const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`\nBuilt ${path.relative(root, out)}: ${mb} MB${Number(mb) >= 25 ? '  (WARNING: over the 25 MB target)' : ''}`);
