// Dominio: sin dependencias externas (sección 2.5). Se completa en F2–F6.

export * from './fingerprint.js';
export * from './inbound.js';
export * from './queues.js';

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
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  jsonSchema: Record<string, unknown>;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmResponse {
  json: unknown;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export type AlertSeverity = 'CRITICA' | 'ALTA' | 'MEDIA';

export interface AlertPort {
  raise(code: string, severity: AlertSeverity, detail?: Record<string, unknown>): Promise<void>;
}

export interface ClockPort {
  now(): Date;
}
