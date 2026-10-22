import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'dist/ui/setup.html');

describe('ui build output', () => {
  it('builds a single self-contained file under 600 KB', () => {
    execFileSync(process.execPath, [resolve(root, 'scripts/build-ui.mjs')], { cwd: root, stdio: 'pipe' });
    expect(statSync(out).size).toBeLessThan(600 * 1024);
    const html = readFileSync(out, 'utf8');
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link[^>]*rel=["']?stylesheet/i);
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]*(src|href)=["']?https?:/i);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    expect(style.length).toBeGreaterThan(100);
    expect(style).not.toMatch(/@import|url\(/i);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('id="app"');
  }, 60000);
});
