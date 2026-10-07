import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createPrismaClient } from './index.js';
import type { PrismaClient } from './generated/prisma/client.js';

/**
 * PostgreSQL temporal para pruebas de integración: se crea en una carpeta temporal, en un
 * puerto libre, con las migraciones del repositorio aplicadas. No toca ninguna base real.
 */
export interface TestDatabase {
  url: string;
  prisma: PrismaClient;
  /** Vacía todas las tablas (entre pruebas). */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const dir = await mkdtemp(join(tmpdir(), 'abaya-pg-'));
  const port = await freePort();
  const password = randomBytes(12).toString('hex');
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'abaya',
    password,
    port,
    // La carpeta se borra aquí: en Windows el borrado interno falla con EBUSY.
    persistent: true,
    // UTF-8 como en producción: en Windows initdb toma WIN1252 por defecto y rechaza emojis.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('abaya_test');
  const url = `postgresql://abaya:${password}@127.0.0.1:${port}/abaya_test`;

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const m of (await readdir(MIGRATIONS, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    await client.query(await readFile(join(MIGRATIONS, m, 'migration.sql'), 'utf8'));
  }
  const { rows } = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  );
  await client.end();
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');

  const prisma = createPrismaClient(url);
  return {
    url,
    prisma,
    async reset() {
      await prisma.$executeRawUnsafe(`TRUNCATE ${tables} CASCADE`);
    },
    async stop() {
      await prisma.$disconnect();
      await server.stop();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
