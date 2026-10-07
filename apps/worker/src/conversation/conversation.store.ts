import type { ConversationStatus } from '@abaya/domain';
import type { KnowledgeUsageRecord } from '@abaya/knowledge';
import type { ConversationState, LlmCallRecord, Profile } from '../engine/types.js';

export interface PendingInbound {
  id: string;
  text: string;
  /** Cuándo lo detectó el robot (Message.createdAt, reloj del robot). */
  detectedAt: Date;
}

export interface TurnInput {
  state: ConversationState;
  abayaChatId: string;
  /** Usuario robot dueño del chat: sus acciones van a la cola de ese robot. */
  robotUser: string;
  status: ConversationStatus;
  /** Mensajes del cliente aún no atendidos por el motor (la ráfaga). */
  pending: PendingInbound[];
}

export type OutboxEventType =
  'ReplyReady' | 'SaleCompleted' | 'TransferRequested' | 'ConversationClosed' | 'NeedsReview';

export interface OutboxEventInput {
  type: OutboxEventType;
  payload: Record<string, unknown>;
}

export interface TurnCommit {
  conversationId: string;
  stage: string;
  profile: Profile;
  status: ConversationStatus;
  /** Entrantes atendidos en este turno (no se marcan si el proveedor falló). */
  processedMessageIds: string[];
  /** Respuestas a enviar, en orden. El store crea los Message salientes. */
  outbound: { text: string; idempotencyKey: string }[];
  /** Detección del primer mensaje de la ráfaga: se guarda en la PRIMERA respuesta (v1.5). */
  respondsToAt?: Date;
  llmCalls: LlmCallRecord[];
  consent?: {
    textShownHash: string;
    templateVersion: string;
    customerReply: string;
    acceptedAt: Date;
  };
  sale?: { process: string; planCode: string; summary: string; catalogVersionId?: string };
  /** v1.9: qué Brains, versiones y registros usó el turno (KnowledgeUsage, D-001 D7). */
  knowledge?: KnowledgeUsageRecord[];
  /** Eventos de outbox. `{{OUTBOUND_IDS}}` en payload.afterMessageIds se resuelve al guardar. */
  events: OutboxEventInput[];
}

/**
 * Persistencia de un turno. `commitTurn` es UNA transacción: estado, mensajes, venta,
 * consentimiento, LlmCall y eventos de outbox se guardan juntos o no se guarda nada
 * (Transactional Outbox, sección 2.5).
 */
export interface ConversationStore {
  loadForTurn(conversationId: string, historyLimit: number): Promise<TurnInput | null>;
  commitTurn(commit: TurnCommit): Promise<{ outboundMessageIds: string[] }>;
}

export const OUTBOUND_IDS_PLACEHOLDER = '{{OUTBOUND_IDS}}';
