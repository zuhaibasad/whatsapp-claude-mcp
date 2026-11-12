import { describe, expect, it, vi } from 'vitest';
import { MUTED_CONSOLE_METHODS, muteConsoleForStdio } from '../../src/mcp/stdout-guard.js';

describe('stdio console guard', () => {
  it('silences every console method that writes to stdout, keeps console.error', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errorFn = vi.fn();
    const fake = Object.assign(Object.create(console) as Console, { error: errorFn });
    for (const m of MUTED_CONSOLE_METHODS) {
      (fake as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => process.stdout.write(String(a[0]));
    }
    muteConsoleForStdio(fake);
    fake.info('Closing session:', { key: 'secret' });
    fake.log('x');
    fake.debug('x');
    fake.warn('Session already closed', {});
    fake.error('real failure');
    expect(write).not.toHaveBeenCalled();
    expect(errorFn).toHaveBeenCalledWith('real failure');
    write.mockRestore();
  });
});
