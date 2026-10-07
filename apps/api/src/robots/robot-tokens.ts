import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** Vida del token de acceso de un robot hijo (v1.6, sección 2.8). */
export const ACCESS_TTL_MS = 60 * 60_000;

export interface AccessClaims {
  /** Usuario robot (Abaya). */
  r: string;
  /** Versión de tokens del robot: subirla invalida todos los accesos emitidos. */
  v: number;
  /** Vencimiento (epoch ms). */
  exp: number;
}

const b64 = (b: Buffer) => b.toString('base64url');

/**
 * Tokens de acceso firmados (HMAC-SHA256). La clave se deriva con HKDF de la clave de cifrado
 * de campos del servidor: no hay un secreto más que administrar y nunca sale del servidor.
 */
export class RobotAccessTokens {
  private readonly key: Buffer;

  constructor(
    fieldEncryptionKeyBase64: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = ACCESS_TTL_MS,
  ) {
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(fieldEncryptionKeyBase64, 'base64'),
        Buffer.from('abaya-rpa'),
        Buffer.from('robot-access-token-v1'),
        32,
      ),
    );
  }

  issue(robotUser: string, version: number): { token: string; expiresAt: number } {
    const claims: AccessClaims = { r: robotUser, v: version, exp: this.now() + this.ttlMs };
    const body = b64(Buffer.from(JSON.stringify(claims)));
    return { token: `v1.${body}.${this.sign(body)}`, expiresAt: claims.exp };
  }

  /** Claims si la firma es válida y no venció; null en cualquier otro caso. */
  verify(token: string | undefined): AccessClaims | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const [, body, sig] = parts as [string, string, string];
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let claims: AccessClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessClaims;
    } catch {
      return null;
    }
    if (typeof claims.r !== 'string' || typeof claims.v !== 'number') return null;
    if (typeof claims.exp !== 'number' || claims.exp <= this.now()) return null;
    return claims;
  }

  private sign(body: string): string {
    return b64(createHmac('sha256', this.key).update(body).digest());
  }
}
