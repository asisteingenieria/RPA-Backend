/** Estados, eventos y límites de los Brains (D-001). */

export const BRAIN_VERSION_STATUSES = [
  'DRAFT',
  'EVALUATING',
  'PUBLISHED',
  'REJECTED',
  'ARCHIVED',
] as const;
export type BrainVersionStatus = (typeof BRAIN_VERSION_STATUSES)[number];

export const KNOWLEDGE_USES = ['CATALOG', 'FULL_CONTEXT', 'SEARCH'] as const;
export type KnowledgeUse = (typeof KNOWLEDGE_USES)[number];

export const SOURCE_STATUSES = ['PROCESSING', 'READY', 'ERROR'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** El único agente que existe hoy (AgentConfigVersion versiona uno solo). */
export const DEFAULT_AGENT_KEY = 'default';

export const KNOWLEDGE_LIMITS = {
  /** Archivo de catálogo (Excel/CSV). */
  catalogMaxBytes: 2 * 1024 * 1024,
  brainNameMax: 80,
  sourceNameMax: 120,
} as const;

/** Eventos de dominio por el outbox (D9). */
export type KnowledgeEventType = 'SourceIngested' | 'SourceFailed' | 'BrainVersionPublished';

export interface SourceIngestedPayload {
  brainId: string;
  sourceId: string;
  records: number;
  draftVersion: number | null;
}

export interface SourceFailedPayload {
  brainId: string;
  sourceId: string;
  reason: string;
}

export interface BrainVersionPublishedPayload {
  brainId: string;
  versionId: string;
  version: number;
  publishedBy: string;
}

/** Trabajo de la cola `abaya.knowledge-ingest`. */
export interface KnowledgeIngestJob {
  sourceId: string;
  requestedBy: string;
}

/** Trazabilidad de lo que un turno usó de un Brain (D7). */
export interface KnowledgeUsageRecord {
  brainId: string;
  brainVersionId: string;
  brainVersion: number;
  kind: KnowledgeUse;
  /** Códigos (o ids de fragmento) entregados al modelo como contexto. */
  provided: string[];
  /** Códigos cuya ficha se insertó en el mensaje al cliente. */
  rendered: string[];
  /** Hash de los registros renderizados, en orden. */
  recordHash: string | null;
}
