import type { PrismaClient } from '@abaya/db';
import { DEFAULT_AGENT_KEY } from '../domain/brain.js';
import { versionRecords, type StoredRecord } from './catalog-versions.js';

/** Catálogo PUBLICADO que usa un agente: el Brain conectado con registros de catálogo. */
export interface PublishedCatalog {
  brainId: string;
  brainName: string;
  versionId: string;
  version: number;
  records: StoredRecord[];
}

export class CatalogConflictError extends Error {
  override name = 'CatalogConflictError';
}

/**
 * Resuelve el catálogo del agente (D4). Un agente tiene a lo sumo UN Brain de catálogo
 * conectado (si hubiera dos, un mismo ID podría tener dos precios): la conexión lo impide y
 * aquí se verifica de nuevo. Sin Brain de catálogo publicado → null (el motor no ofrece).
 */
export async function loadAgentCatalog(
  prisma: PrismaClient,
  agentKey = DEFAULT_AGENT_KEY,
): Promise<PublishedCatalog | null> {
  const links = await prisma.agentBrain.findMany({
    where: { agentKey },
    select: { brain: { select: { id: true, name: true } } },
  });
  const found: PublishedCatalog[] = [];
  for (const { brain } of links) {
    const v = await prisma.brainVersion.findFirst({
      where: { brainId: brain.id, status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
    });
    if (!v) continue;
    const records = await versionRecords(prisma, v.id);
    if (records.length) {
      found.push({
        brainId: brain.id,
        brainName: brain.name,
        versionId: v.id,
        version: v.version,
        records,
      });
    }
  }
  if (found.length > 1) {
    throw new CatalogConflictError(
      `el agente ${agentKey} tiene ${found.length} Brains de catálogo conectados: deja uno solo`,
    );
  }
  return found[0] ?? null;
}

/** ¿El Brain tiene (o tendrá) registros de catálogo? */
export async function isCatalogBrain(prisma: PrismaClient, brainId: string): Promise<boolean> {
  const [sources, records] = await Promise.all([
    prisma.knowledgeSource.count({ where: { brainId, use: 'CATALOG' } }),
    prisma.catalogRecord.count({ where: { version: { brainId } } }),
  ]);
  return sources + records > 0;
}
