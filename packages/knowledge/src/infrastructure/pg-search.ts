import { Prisma, type PrismaClient } from '@abaya/db';
import { cosineSimilarity, reciprocalRankFusion, searchTerms } from '../domain/documents.js';
import type { SearchHit, VectorStore } from '../domain/ports.js';

const CANDIDATES = 20;

/**
 * Búsqueda híbrida sobre `VersionChunk` (K4, D-001): texto completo de PostgreSQL en español
 * (`to_tsvector('spanish', …)`) + similitud de vectores, fusionadas por rango recíproco (RRF).
 *
 * Vectores: se guardan como `double precision[]`, el patrón que documenta pgvector. Si la
 * extensión `vector` está instalada se ordena en SQL con `embedding::vector <=> $q::vector`;
 * si no, se calcula el coseno en el proceso (suficiente para el tamaño de un Brain). Solo se
 * comparan vectores del mismo modelo.
 */
export class PgHybridSearch implements VectorStore {
  private pgvector?: Promise<boolean>;

  constructor(private readonly prisma: PrismaClient) {}

  /** ¿Está instalada la extensión pgvector? (se consulta una vez). */
  hasPgvector(): Promise<boolean> {
    this.pgvector ??= this.prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM pg_extension WHERE extname = 'vector'`
      .then((r) => Number(r[0]?.n ?? 0) > 0)
      .catch(() => false);
    return this.pgvector;
  }

  async search(input: Parameters<VectorStore['search']>[0]): Promise<SearchHit[]> {
    if (!input.versionIds.length) return [];
    const where = this.where(input.versionIds, input.filter);
    const lists: string[][] = [];

    const terms = searchTerms(input.query);
    if (terms.length) {
      const tsquery = terms.join(' | ');
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT c.id
        FROM "VersionChunk" c, to_tsquery('spanish', ${tsquery}) q
        WHERE ${where} AND to_tsvector('spanish', c.text) @@ q
        ORDER BY ts_rank(to_tsvector('spanish', c.text), q) DESC, c.id
        LIMIT ${CANDIDATES}`;
      lists.push(rows.map((r) => r.id));
    }

    if (input.embedding?.length && input.embeddingModel) {
      if (await this.hasPgvector()) {
        const vec = `[${input.embedding.join(',')}]`;
        const rows = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT c.id FROM "VersionChunk" c
          WHERE ${where} AND c."embeddingModel" = ${input.embeddingModel}
            AND cardinality(c.embedding) = ${input.embedding.length}
          ORDER BY c.embedding::vector <=> ${vec}::vector, c.id
          LIMIT ${CANDIDATES}`;
        lists.push(rows.map((r) => r.id));
      } else {
        const rows = await this.prisma.$queryRaw<{ id: string; embedding: number[] }[]>`
          SELECT c.id, c.embedding FROM "VersionChunk" c
          WHERE ${where} AND c."embeddingModel" = ${input.embeddingModel}
            AND cardinality(c.embedding) = ${input.embedding.length}`;
        const q = input.embedding;
        lists.push(
          rows
            .map((r) => ({ id: r.id, s: cosineSimilarity(q, r.embedding) }))
            .sort((a, b) => b.s - a.s || a.id.localeCompare(b.id))
            .slice(0, CANDIDATES)
            .map((r) => r.id),
        );
      }
    }

    const fused = reciprocalRankFusion(lists).slice(0, input.topK);
    if (!fused.length) return [];
    const chunks = await this.prisma.versionChunk.findMany({
      where: { id: { in: fused.map((f) => f.id) } },
      select: { id: true, brainVersionId: true, sourceName: true, text: true },
    });
    const byId = new Map(chunks.map((c) => [c.id, c]));
    return fused.flatMap((f) => {
      const c = byId.get(f.id);
      return c
        ? [
            {
              chunkId: c.id,
              brainVersionId: c.brainVersionId,
              sourceName: c.sourceName,
              text: c.text,
              score: f.score,
            },
          ]
        : [];
    });
  }

  private where(versionIds: string[], filter?: Record<string, string>): Prisma.Sql {
    const parts = [
      Prisma.sql`c."brainVersionId" IN (${Prisma.join(versionIds)})`,
      Prisma.sql`c.use = 'SEARCH'`,
    ];
    for (const [k, v] of Object.entries(filter ?? {})) {
      parts.push(
        Prisma.sql`(c.metadata IS NULL OR NOT (c.metadata ? ${k}) OR c.metadata->>${k} = ${v})`,
      );
    }
    return Prisma.join(parts, ' AND ');
  }
}
