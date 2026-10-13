// Dominio: sin dependencias externas (sección 2.5). Se completa en F2–F6.

export * from './agent-config.js';
export * from './agent-export.js';
export * from './agent-flow.js';
export * from './agent-templates.js';
export * from './fingerprint.js';
export * from './inbound.js';
export * from './outbound.js';
export * from './queues.js';
export * from './speech.js';
export * from './usage.js';

export const CONVERSATION_STATUSES = [
  'ACTIVE',
  'WAITING_CONSENT',
  'TRANSFERRING',
  'TRANSFERRED_BACKOFFICE',
  'CLOSED_NO_SALE',
  'CLOSED_SUPPORT',
  'CLOSED_INACTIVE',
  'NEEDS_REVIEW',
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const STAGES = [
  'MENU',
  'PERFIL',
  'OFERTA',
  'OBJECIONES',
  'AUTORIZACION',
  'TRANSFERENCIA',
  'SOPORTE',
  'CIERRE_SIN_VENTA',
  'ESCALAR',
] as const;
export type Stage = (typeof STAGES)[number];

export const OUTBOUND_STATUSES = [
  'PENDING',
  'SENDING',
  'SENT_VERIFIED',
  'UNCERTAIN',
  'FAILED',
] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

export type DomainEventType =
  | 'MessageReceived'
  | 'ReplyReady'
  | 'SaleCompleted'
  | 'TransferRequested'
  | 'ConversationTransferred'
  | 'ConversationClosed';

export interface DomainEvent<T = unknown> {
  type: DomainEventType;
  payload: T;
  occurredAt: Date;
}

// ---------- Puertos ----------

export interface ChatChannelPort {
  sendMessage(abayaChatId: string, text: string, idempotencyKey: string): Promise<OutboundStatus>;
  writeNote(abayaChatId: string, note: string): Promise<void>;
  transferToBackoffice(abayaChatId: string): Promise<void>;
  closeChat(abayaChatId: string): Promise<void>;
}

export interface LlmPort {
  readonly provider: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface LlmRequest {
  /** Parte fija del prompt (reglas generales): se cachea en el proveedor. */
  systemFixed: string;
  /** Parte variable (estado, perfil, catálogo filtrado). */
  systemDynamic: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Nombre y JSON Schema estricto de la salida estructurada. */
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  timeoutMs?: number;
  /** Modelo de la versión publicada del agente (v1.8); si falta, el del adaptador. */
  model?: string;
  /** 0–0.3 (sección 6.3.6). Los modelos Claude no la aceptan y la ignoran. */
  temperature?: number;
}

export interface LlmResponse {
  json: unknown;
  model: string;
  /** Proveedor que respondió (con respaldo puede no ser el principal). */
  provider?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Error del proveedor. `outage` (D-009): el servicio no responde (timeout, cuota, 5xx, clave
 * inválida) → se pausan todos los robots hasta que un ADMIN reanude. Si es `false`, falló solo
 * este mensaje (bloqueo de contenido, respuesta truncada) → respuesta segura de plantilla.
 */
export class LlmProviderError extends Error {
  override name = 'LlmProviderError';
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    readonly outage = true,
  ) {
    super(message);
  }
}

export type AlertSeverity = 'CRITICA' | 'ALTA' | 'MEDIA';

export interface AlertPort {
  raise(code: string, severity: AlertSeverity, detail?: Record<string, unknown>): Promise<void>;
}

export interface ClockPort {
  now(): Date;
}
