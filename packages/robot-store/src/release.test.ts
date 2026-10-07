import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signRelease, verifyRelease, type ReleaseManifest } from './release.js';

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};
const m: ReleaseManifest = {
  product: 'abaya-robot',
  version: '1.1.0+abc1234',
  sha256: 'a'.repeat(64),
  size: 80_000_000,
  builtAt: '2026-10-07T12:00:00.000Z',
};

describe('paquetes firmados (Ed25519)', () => {
  it('verifica la firma con la clave pública correcta', () => {
    const k = keys();
    expect(verifyRelease(signRelease(m, k.priv), k.pub)).toEqual(m);
  });

  it('rechaza otra clave, un manifiesto alterado o una firma alterada', () => {
    const k = keys();
    const other = keys();
    const s = signRelease(m, k.priv);
    expect(verifyRelease(s, other.pub)).toBeNull();
    expect(
      verifyRelease({ ...s, manifest: s.manifest.replace('1.1.0', '9.9.9') }, k.pub),
    ).toBeNull();
    const sig = Buffer.from(s.signature, 'base64');
    sig[0] = sig[0]! ^ 0xff;
    expect(verifyRelease({ ...s, signature: sig.toString('base64') }, k.pub)).toBeNull();
    expect(verifyRelease({ basura: true }, k.pub)).toBeNull();
  });
});
