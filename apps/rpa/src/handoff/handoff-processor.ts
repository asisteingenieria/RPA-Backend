import type { AlertPort, CloseJob, TransferJob } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import type { HandoffOutcome, TransferRequest } from '../actor/browser-actor.js';
import { sel } from '../abaya/selectors.js';
import type { HandoffRepository } from './handoff.repository.js';

/** Qué hacer con el trabajo de cola. */
export type HandoffDecision =
  | 'DONE'
  /** Los mensajes previos (despedida) aún no se envían: esperar sin gastar intentos. */
  | 'WAIT'
  /** Falla recuperable: reintentar (máximo 2 reintentos, sección 6.5). */
  | 'RETRY'
  /** KillSwitch activo: volver a intentar más tarde. */
  | 'BLOCKED'
  /** Agotado o incierto: revisión humana y alerta crítica. */
  | 'NEEDS_REVIEW';

export const MAX_TRANSFER_RETRIES = 2;

export interface HandoffActor {
  transfer(req: TransferRequest): Promise<HandoffOutcome>;
  closeConversation(abayaChatId: string): Promise<HandoffOutcome>;
}

/**
 * Transferencias y cierres (secciones 6.5 y 6.6). Un cliente que autorizó y no llegó al
 * backoffice es una venta perdida: ante la duda, revisión humana con alerta crítica, nunca
 * un reintento a ciegas (regla 2).
 */
export class HandoffProcessor {
  constructor(
    private readonly d: {
      actor: HandoffActor;
      repo: HandoffRepository;
      alerts: AlertPort;
      logger: Logger;
    },
  ) {}

  async transfer(job: TransferJob, attemptsMade: number): Promise<HandoffDecision> {
    if (!(await this.previousMessagesSettled(job.afterMessageIds))) return 'WAIT';

    let note: string | undefined;
    if (job.target === 'BACKOFFICE') {
      const sale = await this.d.repo.sale(job.conversationId);
      if (!sale) return this.review(job, 'transferencia a backoffice sin venta registrada');
      note = sale.noteOk ? undefined : sale.summary;
    } else {
      note = `Escalado por el agente RPA: el cliente necesita atención humana.\nConversación: ${job.conversationId}`;
    }

    const outcome = await this.d.actor.transfer({
      abayaChatId: job.abayaChatId,
      ...(note ? { note } : {}),
      queueLabel:
        job.target === 'BACKOFFICE'
          ? sel.transfer.backofficeQueueLabel
          : sel.transfer.humanQueueLabel,
    });
    if (
      outcome.result !== 'BLOCKED_KILL_SWITCH' &&
      outcome.noteWritten &&
      job.target === 'BACKOFFICE'
    ) {
      await this.d.repo.markNoteOk(job.conversationId);
    }

    switch (outcome.result) {
      case 'OK':
        await this.d.repo.markTransferred(job.conversationId, job.target);
        this.d.logger.info(
          { conversationId: job.conversationId, target: job.target },
          'chat transferido',
        );
        return 'DONE';
      case 'BLOCKED_KILL_SWITCH':
        return 'BLOCKED';
      case 'UNCERTAIN':
        return this.review(job, outcome.reason);
      case 'FAILED':
        if (attemptsMade >= MAX_TRANSFER_RETRIES)
          return this.review(job, `${outcome.reason} (sin más reintentos)`);
        return 'RETRY';
    }
  }

  async close(job: CloseJob): Promise<HandoffDecision> {
    if (!(await this.previousMessagesSettled(job.afterMessageIds))) return 'WAIT';
    const outcome = await this.d.actor.closeConversation(job.abayaChatId);
    if (outcome.result === 'OK') return 'DONE';
    if (outcome.result === 'BLOCKED_KILL_SWITCH') return 'BLOCKED';
    // Un cierre fallido no pierde ventas: alerta alta y revisión.
    await this.d.repo.markNeedsReview(job.conversationId);
    await this.d.alerts.raise('CLOSE_UNCERTAIN', 'ALTA', {
      conversationId: job.conversationId,
      reason: outcome.reason,
    });
    return 'NEEDS_REVIEW';
  }

  /** Despedida enviada (o ya en un estado final) antes de transferir o cerrar. */
  private async previousMessagesSettled(ids: string[]): Promise<boolean> {
    const statuses = await this.d.repo.outboundStatuses(ids);
    return statuses.every((s) => s !== 'PENDING' && s !== 'SENDING');
  }

  private async review(job: TransferJob, reason: string): Promise<HandoffDecision> {
    await this.d.repo.markNeedsReview(job.conversationId);
    await this.d.alerts.raise(
      job.target === 'BACKOFFICE' ? 'SALE_NOT_TRANSFERRED' : 'ESCALATION_NOT_TRANSFERRED',
      job.target === 'BACKOFFICE' ? 'CRITICA' : 'ALTA',
      { conversationId: job.conversationId, reason },
    );
    return 'NEEDS_REVIEW';
  }
}
