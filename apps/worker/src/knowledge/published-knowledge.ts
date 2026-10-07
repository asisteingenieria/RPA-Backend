import type { PrismaClient } from '@abaya/db';
import {
  agentPublishedVersions,
  EMPTY_KNOWLEDGE,
  KnowledgeRetriever,
  type ConnectedVersion,
  type KnowledgeTurnContext,
  type SaleProcess,
} from '@abaya/knowledge';
import type { Logger } from '@abaya/logger';
import type { TurnKnowledge } from '../engine/conversation-engine.js';

/**
 * Documentos de las versiones PUBLICADAS de los Brains conectados al agente (K3/K4). La lista
 * de versiones se relee cada 30 s, igual que el catálogo; el contenido se consulta por turno.
 */
export class PublishedKnowledge implements TurnKnowledge {
  private versions: ConnectedVersion[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly retriever: KnowledgeRetriever,
    private readonly logger: Logger,
    private readonly refreshMs = 30_000,
  ) {}

  forTurn(input: {
    query: string;
    process?: SaleProcess | undefined;
  }): Promise<KnowledgeTurnContext> {
    return this.versions.length
      ? this.retriever.forTurn(this.versions, input)
      : Promise.resolve(EMPTY_KNOWLEDGE);
  }

  async refresh(): Promise<void> {
    try {
      this.versions = await agentPublishedVersions(this.prisma);
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'no se pudieron leer los Brains publicados: se mantienen los anteriores',
      );
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Versiones fijas (la suite de evaluación: publicadas + el borrador que se evalúa). */
export class FixedKnowledge implements TurnKnowledge {
  constructor(
    private readonly retriever: KnowledgeRetriever,
    private readonly versions: ConnectedVersion[],
  ) {}

  forTurn(input: { query: string; process?: SaleProcess | undefined }) {
    return this.retriever.forTurn(this.versions, input);
  }
}
