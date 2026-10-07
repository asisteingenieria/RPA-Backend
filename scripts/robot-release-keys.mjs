#!/usr/bin/env node
/**
 * Genera el par de claves de publicación de los robots (v1.7, sección 2.9):
 *
 *   pnpm robot:keys            # crea las claves (falla si ya existen)
 *   pnpm robot:keys --forzar   # las reemplaza: los robots instalados dejarán de aceptar
 *                              # paquetes nuevos hasta reinstalarlos con un paquete nuevo
 *
 * - Privada: .secrets/release-signing.key (NUNCA al repositorio, al servidor ni a los equipos;
 *   guardarla en el gestor de secretos o en una bóveda).
 * - Pública: apps/rpa/release-key.pub (va dentro de cada robot; se puede versionar).
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = join(ROOT, '.secrets', 'release-signing.key');
const PUBLIC = join(ROOT, 'apps', 'rpa', 'release-key.pub');

if (existsSync(PRIVATE) && !process.argv.includes('--forzar')) {
  console.error(
    `Ya existe ${PRIVATE}. Use --forzar para reemplazarla (afecta a los robots instalados).`,
  );
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
mkdirSync(dirname(PRIVATE), { recursive: true });
writeFileSync(PRIVATE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(PUBLIC, publicKey.export({ type: 'spki', format: 'pem' }));
console.log(`Clave privada: ${PRIVATE}  (guárdela en el gestor de secretos)`);
console.log(`Clave pública: ${PUBLIC}  (va dentro de cada robot)`);
