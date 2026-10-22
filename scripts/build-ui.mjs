// Bundles ui/main.ts + ui/style.css into one self-contained HTML file: dist/ui/setup.html
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  entryPoints: [resolve(root, 'ui/main.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  tsconfig: resolve(root, 'ui/tsconfig.json'),
  logLevel: 'warning',
});
const js = (result.outputFiles[0]?.text ?? '').replace(/<\/script/gi, '<\\/script');
const css = await readFile(resolve(root, 'ui/style.css'), 'utf8');
const tpl = await readFile(resolve(root, 'ui/index.html'), 'utf8');
const html = tpl.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
const out = resolve(root, 'dist/ui/setup.html');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`built ${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
