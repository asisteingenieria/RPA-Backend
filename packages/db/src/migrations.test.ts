import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

const PKG = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.stop();
});

describe('migraciones', () => {
  it('las migraciones aplicadas producen exactamente el esquema de schema.prisma (sin deriva)', () => {
    const r = spawnSync(
      'npx',
      [
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      { cwd: PKG, env: { ...process.env, DATABASE_URL: db.url }, encoding: 'utf8', shell: true },
    );
    // --exit-code: 0 = sin diferencias, 2 = hay diferencias.
    expect({ status: r.status, out: r.status === 0 ? '' : r.stdout + r.stderr }).toEqual({
      status: 0,
      out: '',
    });
  }, 120_000);
});
