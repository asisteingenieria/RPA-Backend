import type { FieldCipher } from '@abaya/crypto';
import { inboundAad } from '@abaya/domain';
import type { InboundQueue } from './inbound-queue.js';
import type { InboundRepository } from './inbound.repository.js';

/** Mensaje del cliente ya filtrado y con huella, listo para guardar. */
export interface InboundToStore {
  abayaChatId: string;
  fingerprint: string;
  text: string;
  via: 'network' | 'dom';
  occurredAt: Date;
}

/**
 * Dónde termina un mensaje entrante: cifrado, guardado (la huella única evita duplicados) y
 * encolado para el motor. En un robot hijo esto corre en el servidor (v1.6, sección 2.8).
 */
export interface InboundSink {
  chatAssigned(abayaChatId: string): Promise<{ created: boolean }>;
  store(m: InboundToStore): Promise<{ inserted: boolean; conversationCreated: boolean }>;
}

/** El chat ya es de otro robot: un robot no puede escribir en conversaciones ajenas. */
export class ChatOwnedByOtherRobotError extends Error {
  override name = 'ChatOwnedByOtherRobotError';
}

export class DirectInboundSink implements InboundSink {
  constructor(
    private readonly d: {
      robotUser: string;
      repo: InboundRepository;
      queue: InboundQueue;
      cipher: FieldCipher;
    },
  ) {}

  async chatAssigned(abayaChatId: string) {
    const c = await this.conversation(abayaChatId);
    return { created: c.created };
  }

  async store(m: InboundToStore) {
    const conv = await this.conversation(m.abayaChatId);
    const r = await this.d.repo.insertInbound(conv.id, {
      fingerprint: m.fingerprint,
      bodyEncrypted: this.d.cipher.encrypt(m.text, inboundAad(m.fingerprint)),
      detectedVia: m.via,
      occurredAt: m.occurredAt,
    });
    if (r.inserted) {
      await this.d.queue.enqueue({
        conversationId: conv.id,
        abayaChatId: m.abayaChatId,
        messageId: r.id!,
      });
    }
    return { inserted: r.inserted, conversationCreated: conv.created };
  }

  private async conversation(abayaChatId: string) {
    const c = await this.d.repo.ensureConversation(abayaChatId, this.d.robotUser);
    if (c.robotUser && c.robotUser !== this.d.robotUser) {
      throw new ChatOwnedByOtherRobotError(`El chat ${abayaChatId} pertenece a otro robot`);
    }
    return c;
  }
}
