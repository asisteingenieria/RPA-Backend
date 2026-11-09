/**
 * HSTS: el navegador solo vuelve a entrar por HTTPS durante un año. Los navegadores lo ignoran si
 * llega por HTTP (desarrollo) y para hosts que son una IP (RFC 6797 §8.1), así que hoy no cambia
 * nada en el servidor por IP y aplica solo cuando haya nombre y certificado de la CA. Sin
 * `includeSubDomains` ni `preload`: no tocar otros servicios del dominio.
 */
export const HSTS = 'max-age=31536000';

/** Cabeceras de seguridad para la API y el panel (mismo origen, sin recursos externos). */
export function securityHeaders(
  _req: unknown,
  res: { setHeader(name: string, value: string): void },
  next: () => void,
) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader('Strict-Transport-Security', HSTS);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * Valor de `trust proxy` de Express a partir de `TRUST_PROXY`. `false` = ninguno; un número =
 * saltos de proxy; lo demás (`loopback`, subredes separadas por comas) pasa tal cual. `true`
 * confiaría en cualquier `X-Forwarded-For` (falsificable): se trata como 1 salto, nunca hace
 * caer el arranque.
 */
export function parseTrustProxy(value: string): boolean | number | string {
  const v = value.trim().toLowerCase();
  if (v === 'false' || v === '0') return false;
  if (v === 'true') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  return value.trim();
}
