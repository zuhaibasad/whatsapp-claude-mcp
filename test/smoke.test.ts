import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/core/paths.js';

describe('scaffold', () => {
  it('resolves data paths inside the project folder', () => {
    const p = resolvePaths('/tmp/project');
    expect(p.dataDir.endsWith('.wa-bridge')).toBe(true);
    expect(p.storeDb.startsWith(p.dataDir)).toBe(true);
  });
});
