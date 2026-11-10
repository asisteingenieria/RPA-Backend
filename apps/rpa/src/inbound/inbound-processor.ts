import { AUDIO_PLACEHOLDER, fingerprintInput, type InboundMessage } from '@abaya/domain';
import { sha256, type FieldCipher } from '@abaya/crypto';
import type { Logger } from '@abaya/logger';
import { DirectInboundSink, type InboundSink } from '@abaya/robot-store';
import type { InboundQueue } from './inbound-queue.js';
import type { InboundRepository } from './inbound.repository.js';

export type DetectedVia = 'network' | 'dom';

export interface InboundStats {
  received: number;
  stored: number;
  duplicates: number;
  ignoredOwn: number;
  ignoredSystem: number;
  /** D-036: mensajes del cliente al bot yFlow, antes del paso a asesor. */
  ignoredBeforeHandoff: number;
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
    ignoredBeforeHandoff: 0,
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

  /** D-036: huellas de los mensajes al bot yFlow (red y DOM traen el mismo id). */
  private readonly beforeHandoff = new Set<string>();

  private readonly sink: InboundSink;

  constructor(
    private readonly deps: {
      robotUser: string;
      logger: Logger;
      /** Para medir latencia de detección en pruebas y métricas. */
      onStored?: (m: InboundMessage, via: DetectedVia) => void;
    } & (
      | { sink: InboundSink }
      // Modo directo (desarrollo y pruebas): guarda en la base desde el propio robot.
      | { repo: InboundRepository; queue: InboundQueue; cipher: FieldCipher }
    ),
  ) {
    this.sink =
      'sink' in deps
        ? deps.sink
        : new DirectInboundSink({
            robotUser: deps.robotUser,
            repo: deps.repo,
            queue: deps.queue,
            cipher: deps.cipher,
          });
  }

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

  /**
   * D-036: lo que el cliente le escribió al bot yFlow antes de pasar a un asesor ya lo atendió el
   * bot: el robot saluda (D-017) y no lo responde. Se marca antes de procesar el caso, y el
   * respaldo por DOM (mismo id de mensaje, misma huella) también lo salta.
   */
  markBeforeHandoff(abayaChatId: string, messageIds: string[]) {
    for (const messageId of messageIds) {
      this.beforeHandoff.add(
        messageFingerprint({
          abayaChatId,
          messageId,
          sender: 'CUSTOMER',
          text: '',
          occurredAt: new Date(0),
        }),
      );
    }
    while (this.beforeHandoff.size > InboundProcessor.RECENT_MAX) {
      this.beforeHandoff.delete(this.beforeHandoff.values().next().value!);
    }
  }

  /** Chat nuevo asignado → crear Conversation (sección 6.2, paso 5). */
  async chatAssigned(abayaChatId: string): Promise<void> {
    const c = await this.sink.chatAssigned(abayaChatId);
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
    if (this.beforeHandoff.has(fingerprint)) {
      if (!this.recent.has(fingerprint)) {
        this.stats.ignoredBeforeHandoff++;
        this.remember(fingerprint);
        // Sin texto ni datos del cliente: solo el tipo, para revisar el filtro.
        this.deps.logger.info(
          { abayaChatId: m.abayaChatId, via, audio: !!m.media },
          'mensaje al bot antes del paso a asesor: no se responde',
        );
      }
      return;
    }
    if (this.recent.has(fingerprint)) {
      this.stats.duplicates++;
      return;
    }
    const r = await this.sink.store({
      abayaChatId: m.abayaChatId,
      fingerprint,
      // D-010: mientras el robot no descarga la nota de voz (captura pendiente), llega como
      // `[audio]`, igual que antes: el motor no recibe un mensaje vacío.
      text: m.media && !m.text.trim() ? AUDIO_PLACEHOLDER : m.text,
      via,
      occurredAt: m.occurredAt,
    });
    if (r.conversationCreated) this.stats.newConversations++;
    this.remember(fingerprint);
    if (!r.inserted) {
      this.stats.duplicates++;
      return;
    }
    this.stats.stored++;
    if (m.media) {
      // D-036: tipo de adjunto de cada nota de voz (sin contenido) para revisar falsos positivos.
      this.deps.logger.info(
        { abayaChatId: m.abayaChatId, via, mimeType: m.media.mimeType ?? null },
        'nota de voz del cliente',
      );
    }
    this.deps.onStored?.(m, via);
  }
}
