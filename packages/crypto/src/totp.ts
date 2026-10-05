import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('Secreto TOTP inválido (base32)');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  digits?: number;
  periodSec?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

/** Código TOTP (RFC 6238) para el MFA del usuario robot. `secret` puede ser base32 o Buffer. */
export function totp(
  secret: string | Buffer,
  at: Date = new Date(),
  opts: TotpOptions = {},
): string {
  const { digits = 6, periodSec = 30, algorithm = 'sha1' } = opts;
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  const counter = Math.floor(at.getTime() / 1000 / periodSec);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, key).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin =
    ((h[offset]! & 0x7f) << 24) |
    ((h[offset + 1]! & 0xff) << 16) |
    ((h[offset + 2]! & 0xff) << 8) |
    (h[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}
