import { withSerializableRetry, type Prisma, type PrismaClient } from '@abaya/db';
import { DEFAULT_AGENT_KEY } from '../domain/brain.js';
import {
  diffCatalogs,
  parseProcess,
  pickData,
  recordHash,
  SALE_PROCESSES,
  type CatalogRecordData,
  type SaleProcess,
} from '../domain/catalog.js';

export const DEFAULT_CATALOG_BRAIN = 'Catálogo Claro Móvil';

/**
 * Paso único de v1.8 → v1.9: si todavía no hay Brains, el catálogo vigente de la tabla `Plan`
 * (el que el agente ya estaba usando) pasa a ser la v1 PUBLICADA del Brain de catálogo,
 * conectado al agente. No es un cambio de catálogo (mismos planes), por eso no corre la suite.
 * Idempotente: con cualquier Brain existente no hace nada.
 */
export async function bootstrapLegacyCatalog(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ created: boolean; records: number }> {
  if (await prisma.brain.count()) return { created: false, records: 0 };
  const plans = await prisma.plan.findMany({
    where: {
      active: true,
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gt: now } }],
    },
    orderBy: { code: 'asc' },
  });
  const records: CatalogRecordData[] = [];
  for (const p of plans) {
    const process = (SALE_PROCESSES as readonly string[]).includes(p.process)
      ? (p.process as SaleProcess)
      : parseProcess(p.process);
    if (!process) continue;
    records.push({
      process,
      code: p.code,
      name: p.name,
      dataText: `${p.dataGb} GB`,
      sharedDataText: null,
      includesText: p.benefits.length ? p.benefits.join('; ') : null,
      extrasText: null,
      unlimitedAppsText: null,
      callsText: null,
      priceCop: p.priceCop,
      discountText: p.discountText,
    });
  }
  if (!records.length) return { created: false, records: 0 };
  return createPublishedCatalog(prisma, {
    name: DEFAULT_CATALOG_BRAIN,
    records,
    actor: 'sistema',
    action: 'BRAIN_MIGRATED',
    note: 'catálogo vigente de la tabla Plan (v1.8) pasado a Brain',
  });
}

/**
 * Crea un Brain con su v1 PUBLICADA y lo conecta al agente. Solo para la carga INICIAL
 * (migración o `seed` sin catálogo publicado); todo cambio posterior pasa por la evaluación.
 */
export async function createPublishedCatalog(
  prisma: PrismaClient,
  input: {
    name: string;
    records: CatalogRecordData[];
    actor: string;
    action: string;
    note: string;
  },
): Promise<{ created: boolean; records: number }> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        if (await tx.brain.findUnique({ where: { name: input.name } })) {
          return { created: false, records: 0 };
        }
        const brain = await tx.brain.create({ data: { name: input.name, createdBy: input.actor } });
        const diff = diffCatalogs([], input.records);
        const now = new Date();
        const version = await tx.brainVersion.create({
          data: {
            brainId: brain.id,
            version: 1,
            status: 'PUBLISHED',
            diff: diff as unknown as Prisma.InputJsonValue,
            evalSummary: { skipped: input.note } as Prisma.InputJsonValue,
            createdBy: input.actor,
            publishedBy: input.actor,
            publishedAt: now,
          },
        });
        await tx.catalogRecord.createMany({
          data: input.records.map((r) => ({
            ...pickData(r),
            brainVersionId: version.id,
            hash: recordHash(r),
          })),
        });
        await tx.agentBrain.create({
          data: { agentKey: DEFAULT_AGENT_KEY, brainId: brain.id, connectedBy: input.actor },
        });
        await tx.adminAuditLog.create({
          data: {
            actor: input.actor,
            action: input.action,
            target: `${input.name} v1`,
            detail: {
              brainId: brain.id,
              version: 1,
              note: input.note,
              diff,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.outboxEvent.create({
          data: {
            type: 'BrainVersionPublished',
            payload: {
              brainId: brain.id,
              versionId: version.id,
              version: 1,
              publishedBy: input.actor,
            },
          },
        });
        return { created: true, records: input.records.length };
      },
      { isolationLevel: 'Serializable' },
    ),
  );
}
