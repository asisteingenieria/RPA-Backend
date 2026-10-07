import { sha256 } from '@abaya/crypto';
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
import {
  chunkText,
  documentWarnings,
  estimateTokens,
  normalizeDocumentText,
} from '../domain/documents.js';
import type {
  BlobStore,
  DocumentParser,
  EmbeddingProvider,
  FileKind,
  TableParser,
  WebFetcher,
} from '../domain/ports.js';
import { FileRejected } from '../infrastructure/file-detection.js';
import { WebFetchError } from '../infrastructure/web-fetcher.js';
import { KnowledgeError, rebuildDraftFromSources } from './catalog-versions.js';

export interface IngestionDeps {
  prisma: PrismaClient;
  blobs: BlobStore;
  parser: TableParser;
  /** K3/K4: texto de PDF, DOCX, TXT, MD y HTML. */
  documents?: DocumentParser;
  /** K5: páginas web con protección SSRF. */
  web?: WebFetcher;
  /** K4: null o ausente = búsqueda solo por texto completo. */
  embeddings?: EmbeddingProvider | null;
  /** K3: máximo de tokens de una fuente de contexto completo. */
  fullContextMaxTokens?: number;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

export type IngestionOutcome = 'READY' | 'ERROR' | 'SKIPPED';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_KIND: Record<string, FileKind> = {
  'text/csv': 'csv',
  [XLSX_MIME]: 'xlsx',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
};

const DEFAULT_FULL_CONTEXT_MAX = 2_000;

/** Errores de contenido: la fuente queda en ERROR y no se reintenta. */
class ContentError extends Error {
  constructor(
    message: string,
    readonly issues: CatalogIssue[] = [],
  ) {
    super(message);
  }
}

/**
 * Ingesta de una fuente (cola `abaya.knowledge-ingest`, D9). Un contenido inválido NO se
 * reintenta: queda ERROR con el motivo y la lista de problemas. Un fallo de infraestructura
 * (base, proveedor de embeddings caído) sí lanza, para que BullMQ reintente.
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
          lastIngestedAt: new Date(),
        },
      }),
      d.prisma.sourceChunk.deleteMany({ where: { sourceId: source.id } }),
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

  let records = 0;
  try {
    if (source.use === 'CATALOG') records = await ingestCatalog(d, source);
    else await ingestDocument(d, source);
  } catch (err) {
    if (err instanceof ContentError) return fail(err.message, err.issues);
    if (err instanceof FileRejected || err instanceof WebFetchError) return fail(err.message);
    throw err;
  }

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
    records,
    draftVersion,
  };
  await d.prisma.outboxEvent.create({
    data: { type: 'SourceIngested', payload: payload as unknown as Prisma.InputJsonValue },
  });
  return 'READY';
}

type SourceRow = NonNullable<Awaited<ReturnType<PrismaClient['knowledgeSource']['findUnique']>>>;

async function ingestCatalog(d: IngestionDeps, source: SourceRow): Promise<number> {
  const kind = source.mime ? MIME_KIND[source.mime] : undefined;
  if ((kind !== 'xlsx' && kind !== 'csv') || !source.blobRef) {
    throw new ContentError('el catálogo solo se carga desde Excel (.xlsx) o CSV');
  }
  const bytes = await d.blobs.get(source.blobRef);
  const read = await d.parser.parse(bytes, kind);
  const v = validateCatalog(read.table);
  const readWarnings = read.warnings.map((message) => ({ message }));
  if (!v.ok) {
    const more = v.errors.length > 1 ? ` (y ${v.errors.length - 1} problema(s) más)` : '';
    throw new ContentError(`${formatIssue(v.errors[0]!)}${more}`, [
      ...v.errors,
      ...readWarnings,
      ...v.warnings,
    ]);
  }
  const records: CatalogRecordData[] = v.records;

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
      throw new ContentError(
        `el ID ${clash.code} ya está en la fuente «${o.name}»: quítala o reemplázala primero`,
      );
    }
  }

  await d.prisma.knowledgeSource.update({
    where: { id: source.id },
    data: {
      status: 'READY',
      errorReason: null,
      issues: [...readWarnings, ...v.warnings] as unknown as Prisma.InputJsonValue,
      parsed: records as unknown as Prisma.InputJsonValue,
      lastContentHash: source.contentHash,
      lastIngestedAt: new Date(),
    },
  });
  return records.length;
}

async function ingestDocument(d: IngestionDeps, source: SourceRow): Promise<void> {
  if (!d.documents)
    throw new ContentError('la lectura de documentos no está disponible en este proceso');
  let bytes: Uint8Array;
  let kind: FileKind | undefined;
  let blobRef = source.blobRef;
  if (source.kind === 'WEB') {
    if (!d.web || !source.url) throw new ContentError('la fuente web no tiene dirección');
    const page = await d.web.fetch(source.url);
    bytes = page.bytes;
    kind = MIME_KIND[page.mime] ?? 'html';
    // Se guarda la copia leída (cifrada) para poder auditar qué decía la página.
    const newRef = await d.blobs.put(bytes);
    if (blobRef) await d.blobs.delete(blobRef);
    blobRef = newRef;
  } else {
    if (!source.blobRef) throw new ContentError('la fuente no tiene contenido');
    bytes = await d.blobs.get(source.blobRef);
    kind = source.mime ? MIME_KIND[source.mime] : undefined;
  }
  if (!kind || !d.documents.supports(kind))
    throw new ContentError('tipo de documento no soportado');

  const text = normalizeDocumentText(await d.documents.extractText(bytes, kind));
  if (!text) throw new ContentError('el documento no tiene texto');
  const tokens = estimateTokens(text);
  const max = d.fullContextMaxTokens ?? DEFAULT_FULL_CONTEXT_MAX;
  if (source.use === 'FULL_CONTEXT' && tokens > max) {
    throw new ContentError(
      `tiene unos ${tokens} tokens y el máximo para contexto completo es ${max}: cárgalo con el uso Búsqueda`,
    );
  }
  const pieces = source.use === 'FULL_CONTEXT' ? [text] : chunkText(text);
  const warnings: CatalogIssue[] = documentWarnings(text).map((message) => ({ message }));

  let vectors: number[][] = [];
  let model: string | null = null;
  if (source.use === 'SEARCH') {
    if (d.embeddings) {
      vectors = await d.embeddings.embed(pieces, 'document');
      model = d.embeddings.model;
    } else {
      warnings.push({
        message:
          'sin proveedor de embeddings (EMBEDDINGS_PROVIDER): la búsqueda será solo por texto',
      });
    }
  }

  const contentHash = sha256(text);
  await d.prisma.$transaction([
    d.prisma.sourceChunk.deleteMany({ where: { sourceId: source.id } }),
    d.prisma.sourceChunk.createMany({
      data: pieces.map((t, i) => ({
        sourceId: source.id,
        ord: i,
        text: t,
        tokens: estimateTokens(t),
        embedding: vectors[i] ?? [],
        embeddingModel: vectors[i] ? model : null,
      })),
    }),
    d.prisma.knowledgeSource.update({
      where: { id: source.id },
      data: {
        status: 'READY',
        errorReason: null,
        issues: warnings as unknown as Prisma.InputJsonValue,
        blobRef,
        sizeBytes: bytes.length,
        lastContentHash: contentHash,
        lastIngestedAt: new Date(),
      },
    }),
  ]);
}

/**
 * Actualización programada de páginas web (K5): las fuentes WEB con `refreshHours` vencido se
 * vuelven a leer. Si el contenido no cambió, el borrador no cambia (mismo hash).
 */
export async function refreshDueWebSources(
  d: IngestionDeps,
  now = new Date(),
): Promise<{ refreshed: number; failed: number }> {
  const due = await d.prisma.knowledgeSource.findMany({
    where: { kind: 'WEB', refreshHours: { not: null }, status: { not: 'PROCESSING' } },
    select: { id: true, refreshHours: true, lastIngestedAt: true },
  });
  let refreshed = 0;
  let failed = 0;
  for (const s of due) {
    const last = s.lastIngestedAt?.getTime() ?? 0;
    if (now.getTime() - last < s.refreshHours! * 3_600_000) continue;
    const r = await d.prisma.knowledgeSource.updateMany({
      where: { id: s.id, status: { not: 'PROCESSING' } },
      data: { status: 'PROCESSING' },
    });
    if (!r.count) continue;
    const outcome = await ingestSource(d, { sourceId: s.id, requestedBy: 'sistema' });
    if (outcome === 'READY') refreshed++;
    else if (outcome === 'ERROR') failed++;
  }
  return { refreshed, failed };
}
