import { z } from 'zod';

/**
 * Protocolo de la pasarela de robots (v1.6, sección 2.8): lo que un robot hijo le pide al
 * servidor (`POST /robot-api/v1/rpc`) y lo que el servidor le empuja por WebSocket. El robot
 * NUNCA se identifica en los parámetros: el servidor lo deduce del token de acceso.
 */
export const GATEWAY_PATH = 'robot-api/v1';

const id = z.string().min(1).max(200);
const isoDate = z.string().datetime();
const outboundStatus = z.enum(['PENDING', 'SENDING', 'SENT_VERIFIED', 'UNCERTAIN', 'FAILED']);

export const rpcParams = {
  'session.get': z.object({}),
  'session.save': z.object({
    status: z.enum(['ACTIVE', 'RELOGGING', 'DOWN', 'PAUSED']),
    lastHeartbeat: isoDate,
    lastLoginAt: isoDate.nullable(),
    consecutiveFails: z.number().int().min(0).max(1_000),
  }),
  'actionLog.append': z.object({
    action: z.enum(['LOGIN', 'OPEN_CHAT', 'SEND', 'NOTE', 'TRANSFER', 'CLOSE']),
    abayaChatId: id.nullable(),
    result: z.enum(['OK', 'ERROR', 'UNCERTAIN', 'BLOCKED', 'SKIPPED']),
    durationMs: z.number().int().min(0).max(86_400_000),
    traceRef: z.string().max(200).nullable(),
    createdAt: isoDate,
  }),
  'inbound.chatAssigned': z.object({ abayaChatId: id }),
  'inbound.store': z.object({
    abayaChatId: id,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(10_000),
    via: z.enum(['network', 'dom']),
    occurredAt: isoDate,
  }),
  'outbound.get': z.object({ messageId: id }),
  'outbound.setStatus': z.object({
    messageId: id,
    status: outboundStatus,
    incrementAttempts: z.boolean().optional(),
  }),
  'handoff.outboundStatuses': z.object({ messageIds: z.array(id).max(100) }),
  'handoff.sale': z.object({ conversationId: id }),
  'handoff.markNoteOk': z.object({ conversationId: id }),
  'handoff.markTransferred': z.object({
    conversationId: id,
    target: z.enum(['BACKOFFICE', 'HUMAN']),
  }),
  'handoff.markNeedsReview': z.object({ conversationId: id }),
  'recovery.pendingOutbound': z.object({}),
  'recovery.openConversations': z.object({}),
  'recovery.markNeedsReview': z.object({ conversationIds: z.array(id).max(500) }),
  'recovery.enqueueOutbound': z.object({ messageId: id, abayaChatId: id }),
  'presence.claim': z.object({
    instanceId: z.string().uuid(),
    host: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
  }),
  'presence.beat': z.object({ instanceId: z.string().uuid() }),
  'presence.release': z.object({ instanceId: z.string().uuid() }),
  'sweep.idleChats': z.object({ abayaChatIds: z.array(id).max(200) }),
  'update.report': z.object({
    status: z.enum(['WAITING_IDLE', 'DOWNLOADING', 'STAGED', 'APPLIED', 'FAILED', 'ROLLED_BACK']),
    version: z.string().max(64).optional(),
    message: z.string().max(300).optional(),
  }),
  'alerts.raise': z.object({
    code: z.string().regex(/^[A-Z_]{3,60}$/),
    severity: z.enum(['CRITICA', 'ALTA', 'MEDIA']),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
} as const;

export type RpcMethod = keyof typeof rpcParams;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof rpcParams)[M]>;

export const rpcRequestSchema = z.object({
  method: z.enum(Object.keys(rpcParams) as [RpcMethod, ...RpcMethod[]]),
  params: z.unknown(),
});

// ---------- WebSocket: servidor → robot ----------

export type JobKind = 'send' | 'transfer' | 'close';

export type ServerFrame =
  /** `update`: versión que el robot debe instalar cuando esté libre (v1.7), o null. */
  | { t: 'flags'; killSwitch: boolean; paused: boolean; update?: string | null }
  | { t: 'job'; id: string; kind: JobKind; data: unknown; retries?: number };

export type RobotFrame =
  | { t: 'result'; id: string; ok: true; value: unknown }
  | { t: 'result'; id: string; ok: false; error: string };

export const robotFrameSchema = z.discriminatedUnion('ok', [
  z.object({ t: z.literal('result'), id: z.string(), ok: z.literal(true), value: z.unknown() }),
  z.object({ t: z.literal('result'), id: z.string(), ok: z.literal(false), error: z.string() }),
]);

/** Cierre del WebSocket por el servidor: el robot no debe reconectar (deshabilitado, etc.). */
export const WS_CLOSE_REVOKED = 4401;
/** El servidor no reconoce esta instancia como la dueña del robot (duplicado). */
export const WS_CLOSE_NOT_OWNER = 4409;

export const traceAad = (ref: string) => `trace:${ref}`;
export const TRACE_REF_RE = /^[\w-]{10,160}$/;
