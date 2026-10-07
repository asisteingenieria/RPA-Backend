/* eslint-disable no-console -- script de línea de comandos */
/**
 * Carga el catálogo de planes en la base de datos, con validación, y la v1 de la configuración
 * del agente si todavía no hay ninguna.
 *
 *   pnpm --filter @abaya/worker seed -- src/catalog/plans.synthetic.json
 *
 * El catálogo real de Claro (pregunta 16) se carga con este mismo script. Los planes que no
 * vienen en el archivo se desactivan (no se borran: hay ventas que los referencian).
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '@abaya/config';
import { createPrismaClient } from '@abaya/db';
import { DEFAULT_AGENT_CONFIG } from '../engine/prompts/prompts.js';
import { catalogFileSchema } from './catalog.js';

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!file) throw new Error('Uso: seed <archivo-catalogo.json>');
  const catalog = catalogFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const prisma = createPrismaClient(loadConfig().DATABASE_URL);
  let agentCreated = false;
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
      // Configuración del agente (v1.8): si no hay ninguna versión, la v1 del código publicada.
      // Nunca pisa versiones creadas desde el panel.
      if (!(await tx.agentConfigVersion.count())) {
        const { id: _id, ...v1 } = DEFAULT_AGENT_CONFIG;
        await tx.agentConfigVersion.create({
          data: {
            ...v1,
            status: 'PUBLISHED',
            createdBy: 'seed',
            publishedBy: 'seed',
            publishedAt: new Date(),
          },
        });
        agentCreated = true;
      }
    });
    console.log(
      `Catálogo: ${catalog.plans.length} planes. ` +
        (agentCreated
          ? 'Agente v1 publicado.'
          : 'Configuración del agente sin cambios (ya existe).'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
