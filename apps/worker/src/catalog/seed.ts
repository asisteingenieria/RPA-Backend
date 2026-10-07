/* eslint-disable no-console -- script de línea de comandos */
/**
 * Carga el catálogo de planes (Excel o CSV) en el Brain de catálogo (v1.9, D-001), con
 * validación, y la v1 de la configuración del agente si todavía no hay ninguna.
 *
 *   pnpm --filter @abaya/worker seed -- src/catalog/plans.synthetic.csv
 *
 * Primera carga (no hay Brain de catálogo): queda PUBLICADA como v1 y conectada al agente.
 * Después: el archivo reemplaza las fuentes de catálogo y queda como BORRADOR; se publica desde
 * el panel, y publicar pasa por la suite de evaluación (regla 13).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { cipherFromConfig, sha256 } from '@abaya/crypto';
import { loadConfig } from '@abaya/config';
import { createPrismaClient, type Prisma } from '@abaya/db';
import {
  createPublishedCatalog,
  DEFAULT_CATALOG_BRAIN,
  detectFile,
  PgBlobStore,
  rebuildDraftFromSources,
} from '@abaya/knowledge';
import { DEFAULT_AGENT_CONFIG } from '../engine/prompts/prompts.js';
import { readCatalogFile } from './catalog.js';

const ACTOR = 'seed';

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!file) throw new Error('Uso: seed <catalogo.xlsx|catalogo.csv>');
  const records = await readCatalogFile(file);
  const bytes = new Uint8Array(readFileSync(file));
  const detected = await detectFile(bytes, file, ['xlsx', 'csv']);
  const cfg = loadConfig();
  const prisma = createPrismaClient(cfg.DATABASE_URL);
  const blobs = new PgBlobStore(prisma, cipherFromConfig(cfg));
  try {
    const first = await createPublishedCatalog(prisma, {
      name: DEFAULT_CATALOG_BRAIN,
      records,
      actor: ACTOR,
      action: 'BRAIN_SEEDED',
      note: `carga inicial con seed (${basename(file)})`,
    });
    const brain = await prisma.brain.findUniqueOrThrow({ where: { name: DEFAULT_CATALOG_BRAIN } });

    // El archivo queda como la fuente de catálogo del Brain (reemplaza las anteriores).
    const blobRef = await blobs.put(bytes);
    const old = await prisma.knowledgeSource.findMany({
      where: { brainId: brain.id, use: 'CATALOG' },
      select: { id: true, blobRef: true },
    });
    await prisma.knowledgeSource.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    for (const o of old) if (o.blobRef) await blobs.delete(o.blobRef);
    await prisma.knowledgeSource.create({
      data: {
        brainId: brain.id,
        kind: 'FILE',
        use: 'CATALOG',
        name: basename(file),
        mime: detected.mime,
        sizeBytes: bytes.length,
        contentHash: sha256(Buffer.from(bytes)),
        blobRef,
        status: 'READY',
        parsed: records as unknown as Prisma.InputJsonValue,
        issues: [],
        lastIngestedAt: new Date(),
        createdBy: ACTOR,
      },
    });
    await prisma.brain.update({ where: { id: brain.id }, data: { sourcesChangedAt: new Date() } });

    let message: string;
    if (first.created) {
      message = `Catálogo: ${records.length} planes publicados como v1 de «${DEFAULT_CATALOG_BRAIN}».`;
    } else {
      const draft = await rebuildDraftFromSources(prisma, brain.id, ACTOR);
      message =
        draft.version === null
          ? `Catálogo: ${records.length} planes, sin cambios frente a la versión publicada.`
          : `Catálogo: ${records.length} planes en el borrador v${draft.version} ` +
            `(+${draft.diff.added.length} −${draft.diff.removed.length} ~${draft.diff.changed.length}). ` +
            'Publícalo desde el panel: pasa por la suite de evaluación.';
    }

    // Configuración del agente (v1.8): si no hay ninguna versión, la v1 del código publicada.
    // Nunca pisa versiones creadas desde el panel.
    let agentCreated = false;
    if (!(await prisma.agentConfigVersion.count())) {
      const { id: _id, ...v1 } = DEFAULT_AGENT_CONFIG;
      await prisma.agentConfigVersion.create({
        data: {
          ...v1,
          status: 'PUBLISHED',
          createdBy: ACTOR,
          publishedBy: ACTOR,
          publishedAt: new Date(),
        },
      });
      agentCreated = true;
    }
    console.log(
      `${message} ` +
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
