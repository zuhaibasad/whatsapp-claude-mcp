import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/core/paths.js';

describe('scaffold', () => {
  it('resolves data paths inside the project folder', () => {
    const p = resolvePaths('/tmp/project');
    expect(p.dataDir.endsWith('.wa-bridge')).toBe(true);
    expect(p.storeDb.startsWith(p.dataDir)).toBe(true);
  });
});

describe('user data dir', () => {
  it('uses LOCALAPPDATA on Windows and WA_BRIDGE_HOME when set', async () => {
    const { defaultDataDir, resolveUserPaths } = await import('../src/core/paths.js');
    expect(defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32')).toMatch(/AppData[\\/]Local[\\/]wa-bridge$/);
    expect(defaultDataDir({ WA_BRIDGE_HOME: '/tmp/x' }, 'win32')).toMatch(/x$/);
    const p = resolveUserPaths('/tmp/wab');
    expect(p.projectRoot).toBe(p.dataDir);
    expect(p.serviceInfo.startsWith(p.dataDir)).toBe(true);
  });
});
