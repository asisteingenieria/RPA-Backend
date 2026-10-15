import type { ConversationStatus, TranscriptStatus } from '@abaya/domain';
import type { KnowledgeUsageRecord } from '@abaya/knowledge';
import type { ConversationState, LlmCallRecord, Profile } from '../engine/types.js';

export interface PendingInbound {
  id: string;
  /** Texto del cliente; en una nota de voz, su transcripción (vacía hasta transcribir). */
  text: string;
  /** Cuándo lo detectó el robot (Message.createdAt, reloj del robot). */
  detectedAt: Date;
  /** D-010: nota de voz. */
  voice?: { status: TranscriptStatus; durationSec: number | null };
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
  outbound: {
    text: string;
    idempotencyKey: string;
    /** D-014 fase 2: imagen de planes (VersionImage.id); `text` es su pie de foto. */
    imageId?: string;
  }[];
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
  /** 13/10/2026: datos del cliente tras el «SÍ»: se agregan al resumen de la venta al transferir. */
  saleDataNote?: string;
  /** D-023: caso de servicio para el backoffice (no es una venta), con su resumen. */
  serviceCase?: { kind: 'VALIDACION_PORTABILIDAD'; summary: string };
  /** v1.9: qué Brains, versiones y registros usó el turno (KnowledgeUsage, D-001 D7). */
  knowledge?: KnowledgeUsageRecord[];
  /** Eventos de outbox. `{{OUTBOUND_IDS}}` en payload.afterMessageIds se resuelve al guardar. */
  events: OutboxEventInput[];
  /** D-004: versión del agente del turno; se fija en la conversación si aún no tenía. */
  agentVersionId?: string;
}

/**
 * Persistencia de un turno. `commitTurn` es UNA transacción: estado, mensajes, venta,
 * consentimiento, LlmCall y eventos de outbox se guardan juntos o no se guarda nada
 * (Transactional Outbox, sección 2.5).
 */
export interface ConversationStore {
  loadForTurn(conversationId: string, historyLimit: number): Promise<TurnInput | null>;
  commitTurn(commit: TurnCommit): Promise<{ outboundMessageIds: string[] }>;
  /** D-010: audio de una nota de voz que espera transcripción (null si ya no está). */
  voiceAudio(messageId: string): Promise<{ data: Buffer; mimeType: string } | null>;
  /**
   * D-010: guarda la transcripción (cifrada, como cualquier mensaje) y BORRA el audio. Solo
   * cambia notas aún PENDING: dos turnos que compitan no la pisan.
   */
  saveTranscript(messageId: string, t: TranscriptResult): Promise<void>;
}

export interface TranscriptResult {
  status: Exclude<TranscriptStatus, 'PENDING'>;
  text: string;
  model: string | null;
  ms: number | null;
}

export const OUTBOUND_IDS_PLACEHOLDER = '{{OUTBOUND_IDS}}';
