import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FieldCipher,
  GENESIS_HASH,
  appendToChain,
  canonicalJson,
  verifyChain,
  type ChainedRecord,
} from './index.js';

const key = randomBytes(32).toString('base64');

describe('FieldCipher', () => {
  it('cifra y descifra', () => {
    const c = new FieldCipher(key);
    const enc = c.encrypt('Hola, quiero el plan', 'msg:1');
    expect(enc.toString('utf8')).not.toContain('Hola');
    expect(c.decryptString(enc, 'msg:1')).toBe('Hola, quiero el plan');
  });

  it('produce cifrados distintos para el mismo texto (IV aleatorio)', () => {
    const c = new FieldCipher(key);
    expect(c.encrypt('x').equals(c.encrypt('x'))).toBe(false);
  });

  it('falla si el contenido fue alterado', () => {
    const c = new FieldCipher(key);
    const enc = c.encrypt('dato');
    enc[enc.length - 1]! ^= 0xff;
    expect(() => c.decrypt(enc)).toThrow();
  });

  it('falla con AAD distinto', () => {
    const c = new FieldCipher(key);
    expect(() => c.decrypt(c.encrypt('dato', 'a'), 'b')).toThrow();
  });

  it('falla con otra clave', () => {
    const enc = new FieldCipher(key).encrypt('dato');
    expect(() => new FieldCipher(randomBytes(32).toString('base64')).decrypt(enc)).toThrow();
  });

  it('rechaza claves de longitud incorrecta', () => {
    expect(() => new FieldCipher(randomBytes(16).toString('base64'))).toThrow();
  });
});

describe('cadena de hashes', () => {
  function build(n: number) {
    const out: ChainedRecord<{ i: number; action: string }>[] = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < n; i++) {
      const r = appendToChain(prev, { i, action: 'SEND' });
      out.push(r);
      prev = r.hash;
    }
    return out;
  }

  it('verifica una cadena íntegra', () => {
    expect(verifyChain(build(5))).toBe(-1);
  });

  it('detecta un registro modificado', () => {
    const chain = build(5);
    chain[2]!.data.action = 'TRANSFER';
    expect(verifyChain(chain)).toBe(2);
  });

  it('detecta un registro eliminado', () => {
    const chain = build(5);
    chain.splice(1, 1);
    expect(verifyChain(chain)).toBe(1);
  });

  it('canonicalJson es independiente del orden de claves', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
  });
});

describe('rotación de claves', () => {
  const k1 = randomBytes(32).toString('base64');
  const k2 = randomBytes(32).toString('base64');

  it('tras rotar, lo cifrado con la clave anterior sigue legible', () => {
    const old = new FieldCipher({ current: { id: 1, keyBase64: k1 } });
    const enc = old.encrypt('dato viejo', 'x');
    const rotated = new FieldCipher({
      current: { id: 2, keyBase64: k2 },
      previous: [{ id: 1, keyBase64: k1 }],
    });
    expect(rotated.decryptString(enc, 'x')).toBe('dato viejo');
    expect(rotated.needsReencryption(enc)).toBe(true);
    const fresh = rotated.encrypt('dato nuevo', 'x');
    expect(rotated.needsReencryption(fresh)).toBe(false);
    // La clave vieja sola no abre lo nuevo.
    expect(() => old.decrypt(fresh, 'x')).toThrow(/clave 2 no disponible/);
  });

  it('lee el formato v1 (sin id de clave)', async () => {
    const { createCipheriv } = await import('node:crypto');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', Buffer.from(k1, 'base64'), iv);
    c.setAAD(Buffer.from('x'));
    const data = Buffer.concat([c.update('legado'), c.final()]);
    const v1 = Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), data]);
    const ring = new FieldCipher({
      current: { id: 2, keyBase64: k2 },
      previous: [{ id: 1, keyBase64: k1 }],
    });
    expect(ring.decryptString(v1, 'x')).toBe('legado');
  });

  it('parsea claves anteriores y rechaza ids repetidos', () => {
    expect(FieldCipher.parsePrevious(`1:${k1}, 3:${k2}`).map((k) => k.id)).toEqual([1, 3]);
    expect(FieldCipher.parsePrevious('')).toEqual([]);
    expect(
      () =>
        new FieldCipher({
          current: { id: 1, keyBase64: k1 },
          previous: [{ id: 1, keyBase64: k2 }],
        }),
    ).toThrow(/repetido/);
  });
});
