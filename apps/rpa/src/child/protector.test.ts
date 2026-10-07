import { describe, expect, it } from 'vitest';
import { DpapiProtector, PlainProtector, protectorFor } from './protector.js';

describe('protección de secretos del equipo', () => {
  it.runIf(process.platform === 'win32')(
    'DPAPI: protege y recupera; el resultado no contiene el secreto',
    async () => {
      const p = new DpapiProtector();
      const secret = Buffer.from('token-de-renovacion-super-secreto');
      const sealed = await p.protect(secret);
      expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain('super-secreto');
      expect((await p.unprotect(sealed)).equals(secret)).toBe(true);
      await expect(p.unprotect(Buffer.from('basura').toString('base64'))).rejects.toThrow(/DPAPI/);
    },
    30_000,
  );

  it('sin DPAPI solo con permiso explícito', async () => {
    expect(() => protectorFor('none', {})).toThrow(/ROBOT_ALLOW_UNPROTECTED/);
    const p = protectorFor('none', { ROBOT_ALLOW_UNPROTECTED: '1' });
    expect(p).toBeInstanceOf(PlainProtector);
    expect((await p.unprotect(await p.protect(Buffer.from('x')))).toString()).toBe('x');
  });
});
