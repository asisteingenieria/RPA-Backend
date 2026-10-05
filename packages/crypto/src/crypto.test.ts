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
