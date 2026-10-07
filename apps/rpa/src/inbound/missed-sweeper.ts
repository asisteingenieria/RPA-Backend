import type { Logger } from '@abaya/logger';
import type { SweepRepository } from '@abaya/robot-store';

export { PrismaSweepRepository, type SweepRepository } from '@abaya/robot-store';

/** Cada cuánto se revisa la bandeja buscando mensajes no detectados. */
export const SWEEP_EVERY_MS = 15_000;
/** No volver a abrir el mismo chat por este motivo antes de este tiempo. */
const COOLDOWN_MS = 30_000;

export interface SweepActor {
  readInbox(): Promise<{ abayaChatId: string; unread: number }[]>;
  openChat(abayaChatId: string): Promise<boolean>;
}

/**
 * Red de seguridad de la lectura (v1.5, sección 6.2): si el WebSocket se corta un instante
 * (recarga de página, red, reconexión), un mensaje del cliente puede no detectarse. La bandeja
 * igual lo muestra como "no leído": si un chat tiene no leídos y el sistema no tiene nada en
 * curso para él, se abre (por el BrowserActor) para que la lectura normal lo recupere.
 * Abrir un chat de más es inofensivo: la huella única evita duplicados.
 */
export class MissedMessageSweeper {
  private readonly lastOpened = new Map<string, number>();
  /** Chats recuperados desde el arranque (para métricas y pruebas). */
  recovered = 0;

  constructor(
    private readonly d: {
      robotUser: string;
      actor: SweepActor;
      repo: SweepRepository;
      logger: Logger;
      now?: () => number;
    },
  ) {}

  async sweep(): Promise<string[]> {
    const now = this.d.now?.() ?? Date.now();
    const unread = (await this.d.actor.readInbox())
      .filter((c) => c.unread > 0)
      .map((c) => c.abayaChatId);
    if (!unread.length) return [];
    const idle = (await this.d.repo.idleChats(this.d.robotUser, unread)).filter(
      (id) => now - (this.lastOpened.get(id) ?? 0) >= COOLDOWN_MS,
    );
    const opened: string[] = [];
    for (const id of idle) {
      this.lastOpened.set(id, now);
      if (await this.d.actor.openChat(id)) opened.push(id);
    }
    if (opened.length) {
      this.recovered += opened.length;
      this.d.logger.warn(
        { robotUser: this.d.robotUser, chats: opened.length },
        'chats con mensajes no detectados: se abrieron para recuperarlos',
      );
    }
    for (const [id, t] of this.lastOpened)
      if (now - t > 10 * COOLDOWN_MS) this.lastOpened.delete(id);
    return opened;
  }
}
