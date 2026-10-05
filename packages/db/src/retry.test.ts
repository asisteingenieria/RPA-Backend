import { describe, expect, it } from 'vitest';
import { isRetryable, withSerializableRetry } from './retry.js';

describe('isRetryable', () => {
  it('reconoce conflictos de serialización de Prisma y del adaptador pg', () => {
    expect(isRetryable({ code: 'P2034' })).toBe(true);
    const adapter = Object.assign(new Error('TransactionWriteConflict'), {
      name: 'DriverAdapterError',
      cause: { originalCode: '40001', kind: 'TransactionWriteConflict' },
    });
    expect(isRetryable(adapter)).toBe(true);
    expect(isRetryable({ code: 'P2002', meta: { target: ['hash'] } })).toBe(true);
  });

  it('no reintenta otros errores (p. ej. duplicado de huella)', () => {
    expect(isRetryable({ code: 'P2002', meta: { target: ['fingerprint'] } })).toBe(false);
    expect(isRetryable(new Error('otra cosa'))).toBe(false);
  });
});

describe('withSerializableRetry', () => {
  it('reintenta hasta tener éxito', async () => {
    let n = 0;
    const r = await withSerializableRetry(async () => {
      if (++n < 3) throw { code: 'P2034' };
      return 'ok';
    });
    expect([r, n]).toEqual(['ok', 3]);
  });

  it('propaga de inmediato los errores no reintentables', async () => {
    let n = 0;
    await expect(
      withSerializableRetry(async () => {
        n++;
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(n).toBe(1);
  });
});
