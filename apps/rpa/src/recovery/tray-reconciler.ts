import type { Logger } from '@abaya/logger';
import type { RecoveryRepository } from '@abaya/robot-store';

/** Tiempo que una conversación abierta debe faltar de la bandeja para darla por cerrada. */
export const TRAY_GRACE_MS = 60_000;

/**
 * D-037: la bandeja de Avaya manda. Una conversación abierta en la base que no aparece en la
 * bandeja del robot durante `graceMs` seguidos (la cerró o reasignó otro, o se cerró la sesión a
 * la fuerza) pasa a `CLOSED_EXTERNALLY`: deja de verse en vivo y de recibir reactivaciones. No es
 * un error: sin alerta. Solo decide con lecturas fiables de la bandeja (`readTray` devuelve null
 * si la bandeja no está visible o algún caso no tiene número).
 */
export class TrayReconciler {
  private readonly missingSince = new Map<string, number>();

  constructor(
    private readonly d: {
      robotUser: string;
      repo: Pick<RecoveryRepository, 'openConversations' | 'closeMissing'>;
      readTray: () => Promise<string[] | null>;
      logger: Logger;
      graceMs?: number;
      now?: () => number;
    },
  ) {}

  /** Devuelve las conversaciones que cerró en esta pasada. */
  async run(): Promise<string[]> {
    const tray = await this.d.readTray();
    if (!tray) return [];
    const now = this.d.now?.() ?? Date.now();
    const grace = this.d.graceMs ?? TRAY_GRACE_MS;
    const inTray = new Set(tray);
    const open = await this.d.repo.openConversations(this.d.robotUser);

    const due: string[] = [];
    for (const c of open) {
      if (inTray.has(c.abayaChatId)) {
        this.missingSince.delete(c.conversationId);
        continue;
      }
      const since = this.missingSince.get(c.conversationId);
      if (since === undefined) this.missingSince.set(c.conversationId, now);
      else if (now - since >= grace) due.push(c.conversationId);
    }
    // Lo que ya no está abierto en la base no se sigue contando.
    const openIds = new Set(open.map((c) => c.conversationId));
    for (const id of this.missingSince.keys()) if (!openIds.has(id)) this.missingSince.delete(id);

    if (!due.length) return [];
    const closed = await this.d.repo.closeMissing(this.d.robotUser, due);
    for (const id of due) this.missingSince.delete(id);
    this.d.logger.info(
      { robotUser: this.d.robotUser, chats: closed },
      'conversaciones que ya no están en la bandeja de Avaya: cerradas en la base',
    );
    return due;
  }
}
