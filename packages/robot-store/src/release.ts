import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';

/**
 * Paquetes del robot firmados (v1.7, sección 2.9). El manifiesto (versión, SHA-256 y tamaño del
 * zip) se firma con Ed25519; el robot solo instala lo que verifica con la clave pública que
 * trae desde su instalación. La clave privada vive solo donde se arma el paquete.
 */
export const releaseManifestSchema = z.object({
  product: z.literal('abaya-robot'),
  version: z.string().min(1).max(64),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
  builtAt: z.string().datetime(),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Lo que se publica junto al zip: el manifiesto tal cual se firmó y su firma. */
export interface SignedRelease {
  manifest: string;
  signature: string;
}

export function signRelease(m: ReleaseManifest, privateKeyPem: string): SignedRelease {
  const manifest = JSON.stringify(releaseManifestSchema.parse(m));
  const signature = sign(null, Buffer.from(manifest), createPrivateKey(privateKeyPem));
  return { manifest, signature: signature.toString('base64') };
}

/** El manifiesto si la firma es válida con esa clave pública; null en cualquier otro caso. */
export function verifyRelease(signed: unknown, publicKeyPem: string): ReleaseManifest | null {
  const s = z.object({ manifest: z.string().max(10_000), signature: z.string().max(1_000) });
  const parsed = s.safeParse(signed);
  if (!parsed.success) return null;
  try {
    const ok = verify(
      null,
      Buffer.from(parsed.data.manifest),
      createPublicKey(publicKeyPem),
      Buffer.from(parsed.data.signature, 'base64'),
    );
    if (!ok) return null;
    const m = releaseManifestSchema.safeParse(JSON.parse(parsed.data.manifest));
    return m.success ? m.data : null;
  } catch {
    return null;
  }
}

/** Estados de una actualización que el robot reporta al servidor. */
export const UPDATE_STATUSES = [
  'PENDING',
  'WAITING_IDLE',
  'DOWNLOADING',
  'STAGED',
  'APPLIED',
  'FAILED',
  'ROLLED_BACK',
] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** Código de salida del robot: hay una versión nueva preparada; el lanzador la activa. */
export const EXIT_UPDATE = 4;
