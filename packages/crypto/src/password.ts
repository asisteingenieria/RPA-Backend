import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Contraseñas de los usuarios del panel (sección 8): scrypt con sal aleatoria.
 * Formato guardado: `scrypt$N$r$p$sal$hash` (base64), así se pueden subir los costos
 * sin invalidar las contraseñas anteriores.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

export const PASSWORD_MIN_LENGTH = 12;
/** Tope para que una contraseña enorme no sirva para gastar CPU del servidor. */
export const PASSWORD_MAX_LENGTH = 128;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length > PASSWORD_MAX_LENGTH) throw new Error('Contraseña demasiado larga');
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Verificación en tiempo constante. Un hash mal formado nunca valida. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 2 ** 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (expected.length !== KEY_LEN) return false;
  const key = await derive(password, salt, n, r, p);
  return timingSafeEqual(key, expected);
}

/** Hash con los mismos costos, para igualar el tiempo de respuesta cuando el usuario no existe. */
export const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const COMMON = ['contraseña', 'password', '123456', 'qwerty', 'claro', 'abaya', 'admin'];

/** Problemas de una contraseña nueva (lista vacía = aceptada). Sin reglas de composición (NIST 800-63B). */
export function passwordIssues(password: string, username?: string): string[] {
  const issues: string[] = [];
  const lower = password.toLowerCase();
  if (password.length < PASSWORD_MIN_LENGTH)
    issues.push(`Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  if (password.length > PASSWORD_MAX_LENGTH)
    issues.push(`Debe tener como máximo ${PASSWORD_MAX_LENGTH} caracteres`);
  if (username && username.length >= 3 && lower.includes(username.toLowerCase()))
    issues.push('No puede contener el nombre de usuario');
  if (new Set(password).size < 5) issues.push('Tiene muy pocos caracteres distintos');
  if (COMMON.some((w) => lower.includes(w))) issues.push('Contiene una palabra demasiado común');
  return issues;
}

// Sin caracteres ambiguos (0/O, 1/l/I) para dictarla o copiarla sin errores.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Contraseña temporal aleatoria (≈ 94 bits); el usuario la cambia en su primer ingreso. */
export function generateTemporaryPassword(length = 16): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
    if (!passwordIssues(out).length) return out;
  }
}
