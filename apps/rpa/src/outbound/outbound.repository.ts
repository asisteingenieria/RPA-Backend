import type { PrismaClient } from '@abaya/db';
import type { OutboundStatus } from '@abaya/domain';

export interface OutboundMessage {
  id: string;
  abayaChatId: string;
  idempotencyKey: string;
  bodyEncrypted: Buffer;
  status: OutboundStatus;
  attempts: number;
}

export interface OutboundRepository {
  get(messageId: string): Promise<OutboundMessage | null>;
  /** Cambia el estado; con `incrementAttempts` suma un intento (antes de tocar la interfaz). */
  setStatus(messageId: string, status: OutboundStatus, incrementAttempts?: boolean): Promise<void>;
}

export class PrismaOutboundRepository implements OutboundRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(messageId: string): Promise<OutboundMessage | null> {
    const m = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: { select: { abayaChatId: true } } },
    });
    if (!m || m.direction !== 'OUTBOUND' || !m.idempotencyKey) return null;
    return {
      id: m.id,
      abayaChatId: m.conversation.abayaChatId,
      idempotencyKey: m.idempotencyKey,
      bodyEncrypted: Buffer.from(m.bodyEncrypted),
      status: m.status ?? 'PENDING',
      attempts: m.attempts,
    };
  }

  async setStatus(messageId: string, status: OutboundStatus, incrementAttempts = false) {
    const m = await this.prisma.message.update({
      where: { id: messageId },
      data: { status, ...(incrementAttempts ? { attempts: { increment: 1 } } : {}) },
      select: { conversationId: true },
    });
    if (status === 'SENT_VERIFIED') {
      await this.prisma.conversation.update({
        where: { id: m.conversationId },
        data: { lastOutboundAt: new Date() },
      });
    }
  }
}

export class MemoryOutboundRepository implements OutboundRepository {
  readonly messages = new Map<string, OutboundMessage>();
  readonly history: { id: string; status: OutboundStatus }[] = [];

  async get(id: string) {
    const m = this.messages.get(id);
    return m ? { ...m } : null;
  }

  async setStatus(id: string, status: OutboundStatus, incrementAttempts = false) {
    const m = this.messages.get(id);
    if (!m) throw new Error('mensaje no existe');
    m.status = status;
    if (incrementAttempts) m.attempts++;
    this.history.push({ id, status });
  }
}
