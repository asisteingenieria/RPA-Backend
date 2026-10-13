import type { FieldCipher } from '@abaya/crypto';
import type { PrismaClient } from '@abaya/db';
import { knowledgeBlobAad, outboundAad, type OutboundStatus } from '@abaya/domain';

/** D-014 fase 2: imagen de planes que acompaña al mensaje (el texto es su pie de foto). */
export interface OutboundImage {
  /** VersionImage.id */
  id: string;
  mime: string;
  /** Nombre con que se adjunta en Abaya (el de la fuente del Brain). */
  fileName: string;
}

export interface OutboundMessage {
  id: string;
  abayaChatId: string;
  idempotencyKey: string;
  /** Texto a escribir (descifrado del lado de la persistencia: el robot hijo no tiene la clave). */
  text: string;
  status: OutboundStatus;
  attempts: number;
  /** D-014 fase 2: null = mensaje de solo texto. */
  image?: OutboundImage | null;
}

export interface OutboundRepository {
  get(messageId: string): Promise<OutboundMessage | null>;
  /** Cambia el estado; con `incrementAttempts` suma un intento (antes de tocar la interfaz). */
  setStatus(messageId: string, status: OutboundStatus, incrementAttempts?: boolean): Promise<void>;
  /** D-014 fase 2: bytes de la imagen del mensaje (null = no tiene o ya no existe). */
  imageBytes(messageId: string): Promise<Uint8Array | null>;
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
      image: m.imageId ? await this.imageMeta(m.imageId) : null,
    };
  }

  private async imageMeta(imageId: string): Promise<OutboundImage | null> {
    const img = await this.prisma.versionImage.findUnique({
      where: { id: imageId },
      select: { id: true, mime: true, sourceName: true },
    });
    return img ? { id: img.id, mime: img.mime, fileName: img.sourceName } : null;
  }

  async imageBytes(messageId: string): Promise<Uint8Array | null> {
    const m = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { imageId: true, direction: true },
    });
    if (!m?.imageId || m.direction !== 'OUTBOUND') return null;
    const img = await this.prisma.versionImage.findUnique({
      where: { id: m.imageId },
      select: { blobRef: true },
    });
    if (!img) return null;
    // Mismo cifrado que PgBlobStore (@abaya/knowledge): archivo de los Brains en PostgreSQL.
    const blob = await this.prisma.knowledgeBlob.findUnique({ where: { id: img.blobRef } });
    return blob
      ? new Uint8Array(this.cipher.decrypt(blob.dataEncrypted, knowledgeBlobAad(img.blobRef)))
      : null;
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
  /** D-014 fase 2: bytes de la imagen por id de mensaje. */
  readonly images = new Map<string, Uint8Array>();
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

  async imageBytes(id: string) {
    return this.images.get(id) ?? null;
  }
}
