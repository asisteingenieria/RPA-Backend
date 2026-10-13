import type { InboundMessage, SenderType } from '@abaya/domain';
import { z } from 'zod';

/**
 * Parsers del tráfico de red de Abaya (ySocial, docs/abaya-mapa-pantallas.md).
 *
 * Esquemas contra los payloads REALES observados el 09/10/2026 (fixtures sanitizados en
 * fixtures/abaya/network/ysocial-*.json). Solo se validan los campos que el robot usa; el resto
 * pasa sin revisar. Un payload que no cumple se descarta (y se cuenta para la alerta de cambio
 * de interfaz), nunca se adivina.
 */

/** Patrones de URL que el InboundWatcher escucha. */
export const MESSAGE_URL_PATTERNS = {
  /** Caso completo con sus mensajes: la consola lo pide al abrir un caso y con cada mensaje nuevo. */
  caseMessages: /\/services\/messaging\/case(?:\?|$)/,
  /** Tiempo real (Azure SignalR). */
  websocket: /signalr\.net\/client\/?(?:\?|$)/,
} as const;

/** `ReplySource` de una respuesta: 3 = asesor (también el robot), 10 = bot yFlow. */
export const REPLY_SOURCE_AGENT = 3;

const id = z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String);

/**
 * D-010: adjunto. El enlace es un SAS de Azure Blob que se descarga sin la sesión. `MimeType`
 * libre para no descartar el mensaje si trae otro adjunto: solo `audio/*` es nota de voz.
 */
const attachmentSchema = z.object({
  MimeType: z.string().max(100).nullish(),
  FileName: z.string().max(300).nullish(),
  Url: z.string().max(4_000).nullish(),
  Parameters: z
    .object({ AzureStorageUrlAttachment: z.string().max(4_000).nullish() })
    .passthrough()
    .nullish(),
});

const messageSchema = z.object({
  ID: id,
  Body: z.string().nullish(),
  Date: z.string().datetime({ offset: true }),
  IsReply: z.boolean(),
  ReplySource: z.number().int().nullish(),
  PostedBy: z.object({ ID: id }).passthrough().nullish(),
  IsEvent: z.boolean().nullish(),
  Attachments: z.array(attachmentSchema).nullish(),
});

export const caseResponseSchema = z.object({
  Success: z.literal(true),
  Result: z.object({
    Case: z.object({
      ID: id,
      Messages: z.array(messageSchema),
    }),
  }),
});

type YMessage = z.infer<typeof messageSchema>;

function sender(m: YMessage): SenderType {
  if (m.IsEvent) return 'SYSTEM';
  if (!m.IsReply) return m.PostedBy ? 'CUSTOMER' : 'SYSTEM';
  return m.ReplySource === REPLY_SOURCE_AGENT ? 'AGENT' : 'SYSTEM';
}

function audioOf(m: YMessage): InboundMessage['media'] | undefined {
  const a = m.Attachments?.find((x) => x.MimeType?.toLowerCase().startsWith('audio/'));
  const url = a?.Parameters?.AzureStorageUrlAttachment ?? a?.Url;
  if (!a || !url) return undefined;
  return { kind: 'AUDIO', url, ...(a.MimeType ? { mimeType: a.MimeType } : {}) };
}

function toInbound(caseId: string, m: YMessage, position: number): InboundMessage {
  const media = sender(m) === 'CUSTOMER' ? audioOf(m) : undefined;
  return {
    abayaChatId: caseId,
    messageId: m.ID,
    sender: sender(m),
    text: (m.Body ?? '').trim(),
    occurredAt: new Date(m.Date),
    position,
    ...(media ? { media } : {}),
  };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ParsedCase {
  abayaChatId: string;
  messages: InboundMessage[];
}

/** `GET /services/messaging/case`: el caso (abayaChatId = número del caso) y sus mensajes. */
export function parseCaseResponse(body: unknown): ParseResult<ParsedCase> {
  const r = caseResponseSchema.safeParse(body);
  if (!r.success) return { ok: false, error: summarize(r.error) };
  const c = r.data.Result.Case;
  return {
    ok: true,
    value: { abayaChatId: c.ID, messages: c.Messages.map((m, i) => toInbound(c.ID, m, i)) },
  };
}

/** Evento de SignalR: `{ type: 1, target: 'receive', arguments: [{ method, moreInfo }] }`. */
const invocationSchema = z.object({
  type: z.literal(1),
  target: z.string(),
  arguments: z.array(z.unknown()),
});

const newMessageSchema = z.object({
  method: z.literal('NewMessageFromAssignedCase'),
  moreInfo: z.object({ caseId: id, messageId: id }).passthrough(),
});

const statusSchema = z.object({
  method: z.literal('WhatsappMessageStatusChange'),
  moreInfo: z
    .object({
      messageId: id,
      parameters: z
        .object({
          Sent: z.string().nullish(),
          Delivered: z.string().nullish(),
          Read: z.string().nullish(),
        })
        .passthrough(),
    })
    .passthrough(),
});

export type MessageStatus = 'SENT' | 'DELIVERED' | 'READ';

export type ParsedWsEvent =
  /** Llegó un mensaje a un caso asignado: solo ids; el contenido llega con el caso completo. */
  | { kind: 'caseActivity'; abayaChatId: string; messageId: string }
  /** Estado de entrega de un mensaje enviado (respaldo de la verificación de envío). */
  | { kind: 'messageStatus'; messageId: string; status: MessageStatus };

const isTrue = (v: string | null | undefined) => v?.toLowerCase() === 'true';

/**
 * Un frame de SignalR puede traer varios mensajes separados por 0x1E. Devuelve solo los
 * eventos que el robot usa; pings (type 6), saludos y otros métodos se ignoran sin error. Un
 * evento conocido con forma inválida sí es error (posible cambio de interfaz).
 */
export function parseSignalRFrame(raw: string | Buffer): ParseResult<ParsedWsEvent[]> {
  const out: ParsedWsEvent[] = [];
  for (const part of raw.toString().split('\u001e')) {
    if (!part.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(part);
    } catch {
      return { ok: false, error: 'frame no es JSON' };
    }
    const inv = invocationSchema.safeParse(json);
    if (!inv.success || inv.data.target !== 'receive') continue;
    for (const arg of inv.data.arguments) {
      const method = (arg as { method?: unknown } | null)?.method;
      if (method === 'NewMessageFromAssignedCase') {
        const r = newMessageSchema.safeParse(arg);
        if (!r.success) return { ok: false, error: summarize(r.error) };
        out.push({
          kind: 'caseActivity',
          abayaChatId: r.data.moreInfo.caseId,
          messageId: r.data.moreInfo.messageId,
        });
      } else if (method === 'WhatsappMessageStatusChange') {
        const r = statusSchema.safeParse(arg);
        if (!r.success) return { ok: false, error: summarize(r.error) };
        const p = r.data.moreInfo.parameters;
        const status: MessageStatus | null = isTrue(p.Read)
          ? 'READ'
          : isTrue(p.Delivered)
            ? 'DELIVERED'
            : isTrue(p.Sent)
              ? 'SENT'
              : null;
        if (status)
          out.push({ kind: 'messageStatus', messageId: r.data.moreInfo.messageId, status });
      }
    }
  }
  return { ok: true, value: out };
}

/** Resumen del error sin incluir valores del payload (pueden traer datos personales). */
function summarize(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.code}`).join('; ');
}
