/* eslint-disable no-console -- script de línea de comandos */
/**
 * Carga el catálogo de planes y los prompts v1 en la base de datos, con validación.
 *
 *   pnpm --filter @abaya/worker seed -- src/catalog/plans.synthetic.json
 *
 * El catálogo real de Claro (pregunta 16) se carga con este mismo script. Los planes que no
 * vienen en el archivo se desactivan (no se borran: hay ventas que los referencian).
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '@abaya/config';
import { createPrismaClient } from '@abaya/db';
import { BASE_PROMPT, PROMPT_VERSION, STAGE_PROMPTS } from '../engine/prompts/prompts.js';
import { catalogFileSchema } from './catalog.js';

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!file) throw new Error('Uso: seed <archivo-catalogo.json>');
  const catalog = catalogFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const prisma = createPrismaClient(loadConfig().DATABASE_URL);
  try {
    await prisma.$transaction(async (tx) => {
      for (const p of catalog.plans) {
        const data = { ...p, discountText: p.discountText ?? null, validTo: p.validTo ?? null };
        await tx.plan.upsert({ where: { code: p.code }, create: data, update: data });
      }
      await tx.plan.updateMany({
        where: { code: { notIn: catalog.plans.map((p) => p.code) } },
        data: { active: false },
      });
      for (const [stage, content] of Object.entries({ BASE: BASE_PROMPT, ...STAGE_PROMPTS })) {
        await tx.promptVersion.upsert({
          where: { stage_version: { stage, version: PROMPT_VERSION } },
          create: { stage, version: PROMPT_VERSION, content: content!, active: true },
          update: {},
        });
      }
    });
    console.log(
      `Catálogo: ${catalog.plans.length} planes. Prompts v${PROMPT_VERSION} registrados.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
