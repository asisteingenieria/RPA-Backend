import type { PrismaClient } from '@abaya/db';

export interface NewInboundMessage {
  fingerprint: string;
  bodyEncrypted: Buffer;
  detectedVia: 'network' | 'dom';
  occurredAt: Date;
}

export interface InboundRepository {
  /** Crea la conversación si no existe. */
  ensureConversation(
    abayaChatId: string,
    robotUser: string,
  ): Promise<{ id: string; created: boolean; robotUser: string }>;
  /**
   * Inserta el mensaje. La restricción única de `fingerprint` en base de datos es la defensa
   * final contra duplicados (sección 5): si ya existe devuelve `inserted: false`.
   */
  insertInbound(
    conversationId: string,
    msg: NewInboundMessage,
  ): Promise<{ inserted: boolean; id?: string }>;
}

export class PrismaInboundRepository implements InboundRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureConversation(abayaChatId: string, robotUser: string) {
    const existing = await this.prisma.conversation.findUnique({ where: { abayaChatId } });
    if (existing) return { id: existing.id, created: false, robotUser: existing.robotUser };
    try {
      const c = await this.prisma.conversation.create({ data: { abayaChatId, robotUser } });
      return { id: c.id, created: true, robotUser };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const c = await this.prisma.conversation.findUniqueOrThrow({ where: { abayaChatId } });
      return { id: c.id, created: false, robotUser: c.robotUser };
    }
  }

  async insertInbound(conversationId: string, msg: NewInboundMessage) {
    try {
      const [m] = await this.prisma.$transaction([
        this.prisma.message.create({
          data: {
            conversationId,
            direction: 'INBOUND',
            fingerprint: msg.fingerprint,
            bodyEncrypted: new Uint8Array(msg.bodyEncrypted),
            detectedVia: msg.detectedVia,
            occurredAt: msg.occurredAt,
          },
        }),
        this.prisma.conversation.update({
          where: { id: conversationId },
          data: { lastInboundAt: msg.occurredAt },
        }),
      ]);
      return { inserted: true, id: m.id };
    } catch (err) {
      if (isUniqueViolation(err)) return { inserted: false };
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export class MemoryInboundRepository implements InboundRepository {
  readonly conversations = new Map<string, { id: string; robotUser: string }>();
  readonly messages = new Map<string, NewInboundMessage & { id: string; conversationId: string }>();
  private seq = 0;

  async ensureConversation(abayaChatId: string, robotUser: string) {
    const c = this.conversations.get(abayaChatId);
    if (c) return { id: c.id, created: false, robotUser: c.robotUser };
    const id = `conv-${++this.seq}`;
    this.conversations.set(abayaChatId, { id, robotUser });
    return { id, created: true, robotUser };
  }

  async insertInbound(conversationId: string, msg: NewInboundMessage) {
    if (this.messages.has(msg.fingerprint)) return { inserted: false };
    const id = `msg-${++this.seq}`;
    this.messages.set(msg.fingerprint, { ...msg, id, conversationId });
    return { inserted: true, id };
  }
}
