import type { Logger } from '@abaya/logger';
import type { RecoveryRepository } from '@abaya/robot-store';

export { PrismaRecoveryRepository, type RecoveryRepository } from '@abaya/robot-store';

/**
 * Reconciliación al iniciar o recuperar la sesión (sección 6.1, paso 7): reencola los envíos
 * PENDING/SENDING. El BrowserActor es idempotente (verifica en pantalla) y nunca reintenta a
 * ciegas un SENDING (regla 2).
 *
 * D-037: las conversaciones abiertas que ya no están en la bandeja las cierra el
 * `TrayReconciler` (cada 15 s, tras 60 s sin aparecer), no esta pasada: justo después de entrar
 * la bandeja puede no haber cargado.
 */
export class RecoveryService {
  constructor(
    private readonly d: {
      robotUser: string;
      repo: Pick<RecoveryRepository, 'pendingOutbound'>;
      enqueueOutbound: (messageId: string, abayaChatId: string) => Promise<void>;
      logger: Logger;
    },
  ) {}

  async run(): Promise<{ requeued: number }> {
    const pending = await this.d.repo.pendingOutbound(this.d.robotUser);
    for (const p of pending) await this.d.enqueueOutbound(p.messageId, p.abayaChatId);
    this.d.logger.info(
      { robotUser: this.d.robotUser, requeued: pending.length },
      'reconciliación completada',
    );
    return { requeued: pending.length };
  }
}
