import type { FieldCipher } from '@abaya/crypto';
import type { PrismaClient } from '@abaya/db';
import { outboundAad, type OutboundStatus } from '@abaya/domain';

export interface OutboundMessage {
  id: string;
  abayaChatId: string;
  idempotencyKey: string;
  /** Texto a escribir (descifrado del lado de la persistencia: el robot hijo no tiene la clave). */
  text: string;
  status: OutboundStatus;
  attempts: number;
}

export interface OutboundRepository {
  get(messageId: string): Promise<OutboundMessage | null>;
  /** Cambia el estado; con `incrementAttempts` suma un intento (antes de tocar la interfaz). */
  setStatus(messageId: string, status: OutboundStatus, incrementAttempts?: boolean): Promise<void>;
}

export class PrismaOutboundRepository implements OutboundRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

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
      text: this.cipher.decryptString(m.bodyEncrypted, outboundAad(m.idempotencyKey)),
      status: m.status ?? 'PENDING',
      attempts: m.attempts,
    };
  }

  async setStatus(messageId: string, status: OutboundStatus, incrementAttempts = false) {
    // sentAt con el reloj del robot, el mismo que fechó la detección del entrante (v1.5).
    const sentAt = status === 'SENT_VERIFIED' ? new Date() : undefined;
    const m = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        status,
        ...(incrementAttempts ? { attempts: { increment: 1 } } : {}),
        ...(sentAt ? { sentAt } : {}),
      },
      select: { conversationId: true },
    });
    if (sentAt) {
      await this.prisma.conversation.update({
        where: { id: m.conversationId },
        data: { lastOutboundAt: sentAt },
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
