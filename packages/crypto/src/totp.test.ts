import { describe, expect, it } from 'vitest';
import { base32Decode, totp } from './totp.js';

// Vectores del apéndice B de RFC 6238 (SHA-1, 8 dígitos).
const SECRET = Buffer.from('12345678901234567890');

describe('totp', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('t=%i → %s', (t, code) => {
    expect(totp(SECRET, new Date(t * 1000), { digits: 8 })).toBe(code);
  });

  it('acepta secretos en base32', () => {
    // "12345678901234567890" en base32
    const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(base32Decode(b32).equals(SECRET)).toBe(true);
    expect(totp(b32, new Date(59_000))).toBe('287082');
  });

  it('rechaza base32 inválido', () => {
    expect(() => base32Decode('abc1!')).toThrow();
  });
});
