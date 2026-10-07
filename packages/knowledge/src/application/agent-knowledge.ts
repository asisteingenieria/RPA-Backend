import type { PrismaClient } from '@abaya/db';
import { DEFAULT_AGENT_KEY, type KnowledgeUsageRecord } from '../domain/brain.js';
import type { SaleProcess } from '../domain/catalog.js';
import type { EmbeddingProvider, VectorStore } from '../domain/ports.js';

/** Versión de un Brain que usa el agente (la publicada, o el borrador que se evalúa). */
export interface ConnectedVersion {
  brainId: string;
  brainName: string;
  versionId: string;
  version: number;
}

/** Texto de un Brain que va al modelo como dato, dentro de `<documento>`. */
export interface DocumentBlock extends ConnectedVersion {
  kind: 'FULL_CONTEXT' | 'SEARCH';
  chunkId: string;
  sourceName: string;
  text: string;
}

export interface KnowledgeTurnContext {
  blocks: DocumentBlock[];
  usage: KnowledgeUsageRecord[];
}

export const EMPTY_KNOWLEDGE: KnowledgeTurnContext = { blocks: [], usage: [] };

/** Versiones publicadas de todos los Brains conectados al agente. */
export async function agentPublishedVersions(
  prisma: PrismaClient,
  agentKey = DEFAULT_AGENT_KEY,
): Promise<ConnectedVersion[]> {
  const links = await prisma.agentBrain.findMany({
    where: { agentKey },
    select: { brain: { select: { id: true, name: true } } },
  });
  const out: ConnectedVersion[] = [];
  for (const { brain } of links) {
    const v = await prisma.brainVersion.findFirst({
      where: { brainId: brain.id, status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    });
    if (v)
      out.push({ brainId: brain.id, brainName: brain.name, versionId: v.id, version: v.version });
  }
  return out;
}

export interface RetrieverOptions {
  topK: number;
  /** Tope de tokens de contexto completo por turno (todas las fuentes juntas). */
  fullContextBudget?: number;
}

/**
 * Lo que el turno le pasa al modelo de los documentos de los Brains (K3/K4):
 * - CONTEXTO COMPLETO: todos los fragmentos de uso FULL_CONTEXT de las versiones.
 * - BÚSQUEDA: los `topK` fragmentos más relevantes para el mensaje del cliente (híbrida),
 *   filtrados por el proceso de la conversación (metadato `proceso` de la fuente).
 * Todo queda en `KnowledgeUsage` (qué fragmentos de qué versión se usaron).
 */
export class KnowledgeRetriever {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly search: VectorStore,
    private readonly embeddings: EmbeddingProvider | null,
    private readonly opts: RetrieverOptions,
  ) {}

  async forTurn(
    versions: readonly ConnectedVersion[],
    input: { query: string; process?: SaleProcess | undefined },
  ): Promise<KnowledgeTurnContext> {
    if (!versions.length) return EMPTY_KNOWLEDGE;
    const byId = new Map(versions.map((v) => [v.versionId, v]));
    const ids = [...byId.keys()];
    const blocks: DocumentBlock[] = [];

    const full = await this.prisma.versionChunk.findMany({
      where: { brainVersionId: { in: ids }, use: 'FULL_CONTEXT' },
      orderBy: [{ brainVersionId: 'asc' }, { sourceName: 'asc' }, { ord: 'asc' }],
      select: { id: true, brainVersionId: true, sourceName: true, text: true, tokens: true },
    });
    let budget = this.opts.fullContextBudget ?? Number.POSITIVE_INFINITY;
    for (const c of full) {
      if (c.tokens > budget) break;
      budget -= c.tokens;
      blocks.push({
        ...byId.get(c.brainVersionId)!,
        kind: 'FULL_CONTEXT',
        chunkId: c.id,
        sourceName: c.sourceName,
        text: c.text,
      });
    }

    const searchable = await this.prisma.versionChunk.count({
      where: { brainVersionId: { in: ids }, use: 'SEARCH' },
    });
    if (searchable && input.query.trim()) {
      let embedding: number[] | null = null;
      if (this.embeddings) {
        // Sin embeddings de la consulta (proveedor caído) se busca solo por texto.
        embedding = await this.embeddings
          .embed([input.query.slice(0, 2_000)], 'query')
          .then((v) => v[0] ?? null)
          .catch(() => null);
      }
      const hits = await this.search.search({
        versionIds: ids,
        query: input.query,
        embedding,
        embeddingModel: embedding ? this.embeddings!.model : null,
        topK: this.opts.topK,
        ...(input.process ? { filter: { proceso: input.process } } : {}),
      });
      for (const h of hits) {
        blocks.push({
          ...byId.get(h.brainVersionId)!,
          kind: 'SEARCH',
          chunkId: h.chunkId,
          sourceName: h.sourceName,
          text: h.text,
        });
      }
    }

    const usage = new Map<string, KnowledgeUsageRecord>();
    for (const b of blocks) {
      const key = `${b.versionId}:${b.kind}`;
      const u = usage.get(key) ?? {
        brainId: b.brainId,
        brainVersionId: b.versionId,
        brainVersion: b.version,
        kind: b.kind,
        provided: [],
        rendered: [],
        recordHash: null,
      };
      u.provided.push(b.chunkId);
      usage.set(key, u);
    }
    return { blocks, usage: [...usage.values()] };
  }
}
