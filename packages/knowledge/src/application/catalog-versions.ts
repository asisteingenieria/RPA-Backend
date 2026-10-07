import { withSerializableRetry, type Prisma, type PrismaClient } from '@abaya/db';
import {
  diffCatalogs,
  isEmptyDiff,
  pickData,
  recordHash,
  SALE_PROCESSES,
  type CatalogDiff,
  type CatalogRecordData,
  type SaleProcess,
} from '../domain/catalog.js';
import type { BrainVersionPublishedPayload } from '../domain/brain.js';

/**
 * Versiones del catálogo de un Brain (D-001 D3): cada cambio de fuentes arma un BORRADOR con
 * los registros de las fuentes listas; publicar lo deja como la única versión PUBLISHED.
 * Lo usan la API (quitar fuente, restaurar, publicar) y el worker (ingesta, evaluación).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export class KnowledgeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

const RECORD_SELECT = {
  id: true,
  process: true,
  code: true,
  name: true,
  dataText: true,
  sharedDataText: true,
  includesText: true,
  extrasText: true,
  unlimitedAppsText: true,
  callsText: true,
  priceCop: true,
  discountText: true,
  hash: true,
} as const;

export interface StoredRecord extends CatalogRecordData {
  id: string;
  hash: string;
}

export function toStoredRecord(r: {
  id: string;
  process: string;
  code: string;
  name: string | null;
  dataText: string;
  sharedDataText: string | null;
  includesText: string | null;
  extrasText: string | null;
  unlimitedAppsText: string | null;
  callsText: string | null;
  priceCop: number;
  discountText: string | null;
  hash: string;
}): StoredRecord {
  if (!(SALE_PROCESSES as readonly string[]).includes(r.process)) {
    throw new KnowledgeError(409, `registro ${r.code} con proceso inválido ${r.process}`);
  }
  return { ...r, process: r.process as SaleProcess };
}

export async function versionRecords(db: Db, versionId: string): Promise<StoredRecord[]> {
  const rows = await db.catalogRecord.findMany({
    where: { brainVersionId: versionId },
    orderBy: [{ process: 'asc' }, { priceCop: 'asc' }, { code: 'asc' }],
    select: RECORD_SELECT,
  });
  return rows.map(toStoredRecord);
}

/**
 * Consulta EXACTA por proceso en SQL (`WHERE process = $1`). La aserción del resultado la hace
 * quien la llama con `checkPlanQuery`.
 */
export async function versionRecordsFor(
  db: Db,
  versionId: string,
  process: SaleProcess,
): Promise<StoredRecord[]> {
  const rows = await db.catalogRecord.findMany({
    where: { brainVersionId: versionId, process },
    orderBy: [{ priceCop: 'asc' }, { code: 'asc' }],
    select: RECORD_SELECT,
  });
  return rows.map(toStoredRecord);
}

export function publishedVersion(db: Db, brainId: string) {
  return db.brainVersion.findFirst({
    where: { brainId, status: 'PUBLISHED' },
    orderBy: { version: 'desc' },
  });
}

/** Versión de trabajo: la más nueva si no está publicada ni archivada. */
export async function workingVersion(db: Db, brainId: string) {
  const latest = await db.brainVersion.findFirst({
    where: { brainId },
    orderBy: { version: 'desc' },
  });
  if (!latest || latest.status === 'PUBLISHED' || latest.status === 'ARCHIVED') return null;
  return latest;
}

function recordRows(versionId: string, records: CatalogRecordData[]) {
  return records.map((r) => ({ ...pickData(r), brainVersionId: versionId, hash: recordHash(r) }));
}

/** Diferencias de una versión contra la publicada (sin publicada = todo agregado). */
export async function diffAgainstPublished(
  db: Db,
  brainId: string,
  records: CatalogRecordData[],
): Promise<{ diff: CatalogDiff; publishedVersion: number | null }> {
  const pub = await publishedVersion(db, brainId);
  const before = pub ? await versionRecords(db, pub.id) : [];
  return { diff: diffCatalogs(before, records), publishedVersion: pub?.version ?? null };
}

/**
 * Deja como borrador exactamente estos registros. Si son iguales a los publicados, no hay
 * borrador (se borra el que hubiera). Con una versión en evaluación no se toca nada.
 */
export async function replaceDraft(
  prisma: PrismaClient,
  brainId: string,
  records: CatalogRecordData[],
  actor: string,
  basedOn?: number,
): Promise<{ version: number | null; diff: CatalogDiff }> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const working = await workingVersion(tx, brainId);
        if (working?.status === 'EVALUATING') {
          throw new KnowledgeError(409, 'Hay una versión en evaluación: espera el resultado.');
        }
        const { diff, publishedVersion: pubVersion } = await diffAgainstPublished(
          tx,
          brainId,
          records,
        );
        if (isEmptyDiff(diff)) {
          if (working?.status === 'DRAFT') {
            await tx.brainVersion.delete({ where: { id: working.id } });
          }
          return { version: null, diff };
        }
        let versionId: string;
        let version: number;
        if (working?.status === 'DRAFT') {
          await tx.catalogRecord.deleteMany({ where: { brainVersionId: working.id } });
          await tx.brainVersion.update({
            where: { id: working.id },
            data: {
              createdBy: actor,
              diff: diff as unknown as Prisma.InputJsonValue,
              ...(basedOn !== undefined ? { basedOn } : {}),
            },
          });
          versionId = working.id;
          version = working.version;
        } else {
          const max = await tx.brainVersion.aggregate({
            where: { brainId },
            _max: { version: true },
          });
          version = (max._max.version ?? 0) + 1;
          const created = await tx.brainVersion.create({
            data: {
              brainId,
              version,
              status: 'DRAFT',
              basedOn: basedOn ?? pubVersion,
              diff: diff as unknown as Prisma.InputJsonValue,
              createdBy: actor,
            },
          });
          versionId = created.id;
        }
        if (records.length) {
          await tx.catalogRecord.createMany({ data: recordRows(versionId, records) });
        }
        return { version, diff };
      },
      { isolationLevel: 'Serializable' },
    ),
  );
}

/** Registros de las fuentes de catálogo listas del Brain (base del borrador). */
export async function recordsFromSources(db: Db, brainId: string): Promise<CatalogRecordData[]> {
  const sources = await db.knowledgeSource.findMany({
    where: { brainId, use: 'CATALOG', status: 'READY' },
    orderBy: { createdAt: 'asc' },
    select: { parsed: true },
  });
  return sources.flatMap((s) =>
    Array.isArray(s.parsed) ? (s.parsed as unknown as CatalogRecordData[]) : [],
  );
}

/** Rearma el borrador a partir de las fuentes (después de agregar, quitar o reprocesar). */
export async function rebuildDraftFromSources(
  prisma: PrismaClient,
  brainId: string,
  actor: string,
) {
  const records = await recordsFromSources(prisma, brainId);
  return replaceDraft(prisma, brainId, records, actor);
}

/**
 * Publica una versión en evaluación (la llama el worker si la suite pasó). En UNA transacción
 * Serializable: la publicada anterior queda ARCHIVED, auditoría con el diff y evento de outbox.
 */
export async function publishEvaluatedVersion(
  prisma: PrismaClient,
  input: { versionId: string; actor: string; evalSummary: Record<string, unknown> },
): Promise<boolean> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const v = await tx.brainVersion.findUnique({
          where: { id: input.versionId },
          include: { brain: { select: { name: true } } },
        });
        if (v?.status !== 'EVALUATING') return false;
        const records = await versionRecords(tx, v.id);
        const { diff } = await diffAgainstPublished(tx, v.brainId, records);
        await tx.brainVersion.updateMany({
          where: { brainId: v.brainId, status: 'PUBLISHED' },
          data: { status: 'ARCHIVED' },
        });
        const now = new Date();
        await tx.brainVersion.update({
          where: { id: v.id },
          data: {
            status: 'PUBLISHED',
            diff: diff as unknown as Prisma.InputJsonValue,
            evalSummary: input.evalSummary as Prisma.InputJsonValue,
            publishedBy: input.actor,
            publishedAt: now,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            actor: input.actor,
            action: 'BRAIN_PUBLISHED',
            target: `${v.brain.name} v${v.version}`,
            detail: {
              brainId: v.brainId,
              version: v.version,
              diff,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        const payload: BrainVersionPublishedPayload = {
          brainId: v.brainId,
          versionId: v.id,
          version: v.version,
          publishedBy: input.actor,
        };
        await tx.outboxEvent.create({
          data: {
            type: 'BrainVersionPublished',
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    ),
  );
}

export async function rejectEvaluatedVersion(
  prisma: PrismaClient,
  input: { versionId: string; actor: string; evalSummary: Record<string, unknown> },
): Promise<boolean> {
  const v = await prisma.brainVersion.findUnique({
    where: { id: input.versionId },
    include: { brain: { select: { name: true } } },
  });
  if (!v) return false;
  const r = await prisma.brainVersion.updateMany({
    where: { id: v.id, status: 'EVALUATING' },
    data: { status: 'REJECTED', evalSummary: input.evalSummary as Prisma.InputJsonValue },
  });
  if (!r.count) return false;
  await prisma.adminAuditLog.create({
    data: {
      actor: input.actor,
      action: 'BRAIN_REJECTED',
      target: `${v.brain.name} v${v.version}`,
      detail: {
        brainId: v.brainId,
        version: v.version,
        problems: input.evalSummary.problems ?? [],
      } as Prisma.InputJsonValue,
    },
  });
  return true;
}
