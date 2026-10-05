import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '../../.env' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` no necesita conexión; las migraciones sí.
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/abaya_rpa',
  },
});
