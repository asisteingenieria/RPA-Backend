/* eslint-disable no-console -- script de línea de comandos */
/**
 * Alta del primer ADMIN del panel, o recuperación cuando nadie puede entrar (sección 8).
 *
 *   pnpm --filter @abaya/api create-admin -- <usuario>           # crea el ADMIN
 *   pnpm --filter @abaya/api create-admin -- <usuario> --reset   # nueva contraseña temporal
 *
 * Imprime una contraseña temporal UNA sola vez; el usuario debe cambiarla al entrar.
 * Corre en el servidor (acceso a la base de datos), nunca expuesto por HTTP.
 */
import { loadConfig } from '@abaya/config';
import { createPrismaClient } from '@abaya/db';
import { UsersError, UsersService } from '../admin/users.service.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const reset = args.includes('--reset');
const username = args.find((a) => !a.startsWith('--'));
if (!username) {
  console.error('Uso: create-admin <usuario> [--reset]');
  process.exit(2);
}

const cfg = loadConfig();
const prisma = createPrismaClient(cfg.DATABASE_URL);
try {
  const r = await new UsersService(prisma).bootstrapAdmin(username, { reset });
  console.log(
    `${r.created ? 'ADMIN creado' : 'Contraseña restablecida'}: ${r.user.username}\n` +
      `Contraseña temporal (se muestra una sola vez): ${r.temporaryPassword}\n` +
      'Debe cambiarla en su primer ingreso al panel.',
  );
} catch (err) {
  console.error(err instanceof UsersError ? err.message : 'No se pudo crear el usuario');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
