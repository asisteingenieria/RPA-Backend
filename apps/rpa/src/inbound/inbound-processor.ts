import { fingerprintInput, inboundAad, type InboundMessage } from '@abaya/domain';
import { sha256, type FieldCipher } from '@abaya/crypto';
import type { Logger } from '@abaya/logger';
import type { InboundQueue } from './inbound-queue.js';
import type { InboundRepository } from './inbound.repository.js';

export type DetectedVia = 'network' | 'dom';

export interface InboundStats {
  received: number;
  stored: number;
  duplicates: number;
  ignoredOwn: number;
  ignoredSystem: number;
  newConversations: number;
}

export function messageFingerprint(m: InboundMessage): string {
  return sha256(fingerprintInput(m));
}

/**
 * Sección 6.2, pasos 3–5: huella → insertar (si existe, ignorar) → encolar `abaya.inbound`.
 * Ignora mensajes propios del robot y del sistema. No toca la interfaz (regla 4).
 * Serializa por chat para que red y DOM no compitan al crear la conversación.
 */
export class InboundProcessor {
  readonly stats: InboundStats = {
    received: 0,
    stored: 0,
    duplicates: 0,
    ignoredOwn: 0,
    ignoredSystem: 0,
    newConversations: 0,
  };
  private readonly chains = new Map<string, Promise<unknown>>();
  /**
   * Huellas vistas hace poco: evita ir a la base de datos por cada re-render o poll que
   * repite el historial. La garantía final sigue siendo la restricción única en BD.
   */
  private readonly recent = new Set<string>();
  private static readonly RECENT_MAX = 20_000;

  private remember(fingerprint: string) {
    this.recent.add(fingerprint);
    if (this.recent.size > InboundProcessor.RECENT_MAX) {
      this.recent.delete(this.recent.values().next().value!);
    }
  }

  constructor(
    private readonly deps: {
      robotUser: string;
      repo: InboundRepository;
      queue: InboundQueue;
      cipher: FieldCipher;
      logger: Logger;
      /** Para medir latencia de detección en pruebas y métricas. */
      onStored?: (m: InboundMessage, via: DetectedVia) => void;
    },
  ) {}

  handle(m: InboundMessage, via: DetectedVia): Promise<void> {
    const prev = this.chains.get(m.abayaChatId) ?? Promise.resolve();
    const next = prev.then(() => this.process(m, via));
    const settled = next.catch((err: unknown) => {
      this.deps.logger.error(
        { abayaChatId: m.abayaChatId, err: err instanceof Error ? err.name : 'unknown' },
        'error procesando mensaje entrante',
      );
    });
    this.chains.set(m.abayaChatId, settled);
    void settled.then(() => {
      if (this.chains.get(m.abayaChatId) === settled) this.chains.delete(m.abayaChatId);
    });
    return settled;
  }

  /** Chat nuevo asignado → crear Conversation (sección 6.2, paso 5). */
  async chatAssigned(abayaChatId: string): Promise<void> {
    const c = await this.deps.repo.ensureConversation(abayaChatId, this.deps.robotUser);
    if (c.created) this.stats.newConversations++;
  }

  /** Espera a que termine todo lo pendiente (pruebas y apagado ordenado). */
  async drain(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  private async process(m: InboundMessage, via: DetectedVia) {
    this.stats.received++;
    if (m.sender === 'AGENT') {
      this.stats.ignoredOwn++;
      return;
    }
    if (m.sender === 'SYSTEM') {
      this.stats.ignoredSystem++;
      return;
    }
    const fingerprint = messageFingerprint(m);
    if (this.recent.has(fingerprint)) {
      this.stats.duplicates++;
      return;
    }
    const conv = await this.deps.repo.ensureConversation(m.abayaChatId, this.deps.robotUser);
    if (conv.created) this.stats.newConversations++;
    const r = await this.deps.repo.insertInbound(conv.id, {
      fingerprint,
      bodyEncrypted: this.deps.cipher.encrypt(m.text, inboundAad(fingerprint)),
      detectedVia: via,
      occurredAt: m.occurredAt,
    });
    this.remember(fingerprint);
    if (!r.inserted) {
      this.stats.duplicates++;
      return;
    }
    this.stats.stored++;
    await this.deps.queue.enqueue({
      conversationId: conv.id,
      abayaChatId: m.abayaChatId,
      messageId: r.id!,
    });
    this.deps.onStored?.(m, via);
  }
}
