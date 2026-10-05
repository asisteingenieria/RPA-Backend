import type { InboundMessage, SenderType } from '@abaya/domain';
import { z } from 'zod';

/**
 * Parsers del tráfico de red de Abaya (XHR y WebSocket).
 *
 * PROVISIONAL: esquemas definidos contra el Abaya simulado. En F1 real se ajustan a los
 * payloads sanitizados de fixtures/abaya/network/. Un payload que no cumple el esquema se
 * descarta (y se cuenta para la alerta de cambio de interfaz), nunca se adivina.
 */

/** Patrones de URL que el InboundWatcher escucha. */
export const MESSAGE_URL_PATTERNS = {
  chatMessages: /\/api\/chats\/([^/]+)\/messages(?:\?|$)/,
  websocket: /\/ws(?:\?|$)/,
} as const;

const senderSchema = z.enum(['customer', 'agent', 'system']);

const messageSchema = z.object({
  id: z.string().min(1),
  sender: z.object({ type: senderSchema }),
  text: z.string(),
  sentAt: z.string().datetime({ offset: true }),
});

export const chatMessagesResponseSchema = z.object({
  chatId: z.string().min(1),
  messages: z.array(messageSchema),
});

export const wsFrameSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('message.created'),
    data: messageSchema.extend({ chatId: z.string().min(1) }),
  }),
  z.object({
    event: z.literal('chat.assigned'),
    data: z.object({ chatId: z.string().min(1) }),
  }),
  z.object({
    event: z.literal('chat.removed'),
    data: z.object({ chatId: z.string().min(1) }),
  }),
]);

export type WsFrame = z.infer<typeof wsFrameSchema>;

const SENDER: Record<z.infer<typeof senderSchema>, SenderType> = {
  customer: 'CUSTOMER',
  agent: 'AGENT',
  system: 'SYSTEM',
};

function toInbound(
  chatId: string,
  m: z.infer<typeof messageSchema>,
  position?: number,
): InboundMessage {
  return {
    abayaChatId: chatId,
    messageId: m.id,
    sender: SENDER[m.sender.type],
    text: m.text,
    occurredAt: new Date(m.sentAt),
    ...(position !== undefined ? { position } : {}),
  };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseChatMessagesResponse(body: unknown): ParseResult<InboundMessage[]> {
  const r = chatMessagesResponseSchema.safeParse(body);
  if (!r.success) return { ok: false, error: summarize(r.error) };
  return { ok: true, value: r.data.messages.map((m, i) => toInbound(r.data.chatId, m, i)) };
}

export type ParsedWsEvent =
  | { kind: 'message'; message: InboundMessage }
  | { kind: 'chatAssigned'; abayaChatId: string }
  | { kind: 'chatRemoved'; abayaChatId: string };

export function parseWsFrame(raw: string | Buffer): ParseResult<ParsedWsEvent> {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString());
  } catch {
    return { ok: false, error: 'frame no es JSON' };
  }
  const r = wsFrameSchema.safeParse(json);
  if (!r.success) return { ok: false, error: summarize(r.error) };
  const f = r.data;
  switch (f.event) {
    case 'message.created':
      return { ok: true, value: { kind: 'message', message: toInbound(f.data.chatId, f.data) } };
    case 'chat.assigned':
      return { ok: true, value: { kind: 'chatAssigned', abayaChatId: f.data.chatId } };
    case 'chat.removed':
      return { ok: true, value: { kind: 'chatRemoved', abayaChatId: f.data.chatId } };
  }
}

/** Resumen del error sin incluir valores del payload (pueden traer datos personales). */
function summarize(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.code}`).join('; ');
}
