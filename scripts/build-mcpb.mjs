// Builds build/chatai-<version>-<windows|macos>.mcpb for Claude Desktop.
// Usage: node scripts/build-mcpb.mjs [--target windows|macos]   (default: the current OS)
// windows = win32-x64; macos = darwin arm64 + x64 in one bundle.
// Steps: npm run build -> stage app + license files -> npm ci --omit=dev in the stage -> prune -> mcpb pack.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'build', 'mcpb');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const TARGETS = {
  windows: { os: 'win32', cpus: ['x64'], keep: ['win32-x64'], platforms: ['win32'] },
  macos: { os: 'darwin', cpus: ['arm64', 'x64'], keep: ['darwin-arm64', 'darwin-x64', 'darwin-universal'], platforms: ['darwin'] },
};
const ti = process.argv.indexOf('--target');
const targetName = ti > 0 ? process.argv[ti + 1] : process.platform === 'darwin' ? 'macos' : 'windows';
const target = TARGETS[targetName];
if (!target) throw new Error(`unknown --target ${targetName}: use windows or macos`);
const out = path.join(root, 'build', `chatai-${pkg.version}-${targetName}.mcpb`);
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
manifest.compatibility = { ...manifest.compatibility, platforms: target.platforms };
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
const icon = path.join(root, 'packaging', 'mcpb', 'icon.png');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(stage, 'icon.png'));

console.log('3/5 installing production dependencies (needs network)');
const ciArgs = (cpu) => ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${target.os}`, `--cpu=${cpu}`];
run(npm, ciArgs(target.cpus[0]), stage);
// npm honours only one --cpu, so each extra architecture is installed separately and its native packages merged in.
for (const cpu of target.cpus.slice(1)) {
  const extra = `${stage}-${cpu}`;
  rm(extra);
  fs.mkdirSync(extra, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(stage, file), path.join(extra, file));
  run(npm, ciArgs(cpu), extra);
  const enm = path.join(extra, 'node_modules');
  for (const scope of fs.readdirSync(enm).filter((n) => n.startsWith('@'))) {
    for (const n of fs.readdirSync(path.join(enm, scope))) {
      const dest = path.join(stage, 'node_modules', scope, n);
      if (n.includes(`${target.os}-${cpu}`) && !fs.existsSync(dest)) fs.cpSync(path.join(enm, scope, n), dest, { recursive: true });
    }
  }
  rm(extra);
}

console.log('4/5 pruning');
const nm = path.join(stage, 'node_modules');
// better-sqlite3-multiple-ciphers: keep only the target's prebuilds; drop sqlite sources.
const bs = path.join(nm, 'better-sqlite3-multiple-ciphers');
if (fs.existsSync(bs)) {
  rm(path.join(bs, 'deps'));
  rm(path.join(bs, 'src'));
  const pre = path.join(bs, 'prebuilds');
  if (fs.existsSync(pre)) for (const f of fs.readdirSync(pre)) if (!target.keep.some((k) => f.startsWith(k))) rm(path.join(pre, f));
}
rm(path.join(nm, 'node-addon-api'));
// OCR: Node loads only the *-lstm cores (wasm file next to the .js loader) and we use the compact best_int English data.
const tcore = path.join(nm, 'tesseract.js-core');
if (fs.existsSync(tcore)) {
  for (const f of fs.readdirSync(tcore)) {
    if (!/^tesseract-core/.test(f)) continue;
    if (!/-lstm\.(js|wasm)$/.test(f)) rm(path.join(tcore, f));
  }
}
rm(path.join(nm, '@tesseract.js-data', 'eng', '4.0.0'));
rm(path.join(nm, 'zlibjs')); // browser-only gunzip; the Node worker uses node:zlib
// sharp (+ @img native libvips): baileys loads it lazily, with a catch, only to make thumbnails and profile pictures
// for SENDING. Read-only never needs it; dropping it saves about 19 MB per architecture.
rm(path.join(nm, 'sharp'));
rm(path.join(nm, '@img'));
// Other platforms' optional native packages, if any slipped in.
for (const scope of fs.existsSync(nm) ? fs.readdirSync(nm).filter((n) => n.startsWith('@')) : []) {
  for (const n of fs.readdirSync(path.join(nm, scope))) {
    const platformPkg = /-(darwin|linux|win32|freebsd|android|openharmony|wasm32)/.test(n);
    if (platformPkg && !target.keep.some((k) => n.includes(k))) rm(path.join(nm, scope, n));
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
