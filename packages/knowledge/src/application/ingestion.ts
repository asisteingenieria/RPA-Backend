import type { Prisma, PrismaClient } from '@abaya/db';
import type {
  KnowledgeIngestJob,
  SourceFailedPayload,
  SourceIngestedPayload,
} from '../domain/brain.js';
import {
  formatIssue,
  validateCatalog,
  type CatalogIssue,
  type CatalogRecordData,
} from '../domain/catalog.js';
import type { BlobStore, TableParser } from '../domain/ports.js';
import { FileRejected } from '../infrastructure/file-detection.js';
import { KnowledgeError, rebuildDraftFromSources } from './catalog-versions.js';

export interface IngestionDeps {
  prisma: PrismaClient;
  blobs: BlobStore;
  parser: TableParser;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

export type IngestionOutcome = 'READY' | 'ERROR' | 'SKIPPED';

const kindOf = (mime: string | null): 'xlsx' | 'csv' | null =>
  mime === 'text/csv'
    ? 'csv'
    : mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ? 'xlsx'
      : null;

/**
 * Ingesta de una fuente (cola `abaya.knowledge-ingest`, D9). Un archivo inválido NO se
 * reintenta: queda ERROR con el motivo y la lista de problemas (fila y columna). Un fallo de
 * infraestructura sí lanza, para que BullMQ reintente.
 */
export async function ingestSource(
  d: IngestionDeps,
  job: KnowledgeIngestJob,
): Promise<IngestionOutcome> {
  const source = await d.prisma.knowledgeSource.findUnique({ where: { id: job.sourceId } });
  if (!source || source.status !== 'PROCESSING') return 'SKIPPED';

  const fail = async (reason: string, issues: CatalogIssue[] = []) => {
    const payload: SourceFailedPayload = { brainId: source.brainId, sourceId: source.id, reason };
    await d.prisma.$transaction([
      d.prisma.knowledgeSource.update({
        where: { id: source.id },
        data: {
          status: 'ERROR',
          errorReason: reason.slice(0, 500),
          issues: issues as unknown as Prisma.InputJsonValue,
          parsed: undefined,
          lastIngestedAt: new Date(),
        },
      }),
      d.prisma.outboxEvent.create({
        data: { type: 'SourceFailed', payload: payload as unknown as Prisma.InputJsonValue },
      }),
      d.prisma.brain.update({
        where: { id: source.brainId },
        data: { sourcesChangedAt: new Date() },
      }),
    ]);
    d.log?.('fuente con error', { sourceId: source.id, reason });
    return 'ERROR' as const;
  };

  if (source.use !== 'CATALOG') {
    return fail('este uso todavía no está disponible (llega en las fases K3 y K4)');
  }
  const kind = kindOf(source.mime);
  if (!kind || !source.blobRef) return fail('el catálogo solo se carga desde Excel (.xlsx) o CSV');

  const bytes = await d.blobs.get(source.blobRef);
  let records: CatalogRecordData[];
  let warnings: CatalogIssue[];
  try {
    const read = await d.parser.parse(bytes, kind);
    const v = validateCatalog(read.table);
    const readWarnings = read.warnings.map((message) => ({ message }));
    if (!v.ok) {
      const issues = [...v.errors, ...readWarnings, ...v.warnings];
      const more = v.errors.length > 1 ? ` (y ${v.errors.length - 1} problema(s) más)` : '';
      return fail(`${formatIssue(v.errors[0]!)}${more}`, issues);
    }
    records = v.records;
    warnings = [...readWarnings, ...v.warnings];
  } catch (err) {
    if (err instanceof FileRejected) return fail(err.message);
    throw err;
  }

  // Un ID no puede venir de dos fuentes del mismo Brain (sería ambiguo cuál precio vale).
  const others = await d.prisma.knowledgeSource.findMany({
    where: { brainId: source.brainId, use: 'CATALOG', status: 'READY', id: { not: source.id } },
    select: { name: true, parsed: true },
  });
  const codes = new Set(records.map((r) => r.code));
  for (const o of others) {
    const clash = ((o.parsed ?? []) as unknown as CatalogRecordData[]).find((r) =>
      codes.has(r.code),
    );
    if (clash) {
      return fail(
        `el ID ${clash.code} ya está en la fuente «${o.name}»: quítala o reemplázala primero`,
      );
    }
  }

  await d.prisma.knowledgeSource.update({
    where: { id: source.id },
    data: {
      status: 'READY',
      errorReason: null,
      issues: warnings as unknown as Prisma.InputJsonValue,
      parsed: records as unknown as Prisma.InputJsonValue,
      lastIngestedAt: new Date(),
    },
  });
  await d.prisma.brain.update({
    where: { id: source.brainId },
    data: { sourcesChangedAt: new Date() },
  });

  let draftVersion: number | null = null;
  try {
    draftVersion = (await rebuildDraftFromSources(d.prisma, source.brainId, job.requestedBy))
      .version;
  } catch (err) {
    // Versión en evaluación: el borrador se rearma cuando termine (ver la evaluación del Brain).
    if (!(err instanceof KnowledgeError)) throw err;
    d.log?.('borrador pendiente: hay una versión en evaluación', { brainId: source.brainId });
  }
  const payload: SourceIngestedPayload = {
    brainId: source.brainId,
    sourceId: source.id,
    records: records.length,
    draftVersion,
  };
  await d.prisma.outboxEvent.create({
    data: { type: 'SourceIngested', payload: payload as unknown as Prisma.InputJsonValue },
  });
  return 'READY';
}
