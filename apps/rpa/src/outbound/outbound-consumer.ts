import { QUEUES, robotQueue, type OutboundJob } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import { Worker } from 'bullmq';
import { ActionBlockedError, type BrowserActor } from '../actor/browser-actor.js';

/**
 * Consume `abaya.outbound` con concurrencia 1 (sección 2.4) y delega en el BrowserActor.
 * - Bloqueado por KillSwitch: el trabajo falla y la cola lo reintenta más tarde.
 * - UNCERTAIN: el trabajo termina; nunca se reintenta solo (regla 2).
 */
export class OutboundConsumer {
  private readonly worker: Worker<OutboundJob>;

  constructor(redisUrl: string, robotUser: string, actor: BrowserActor, logger: Logger) {
    this.worker = new Worker<OutboundJob>(
      robotQueue(QUEUES.outbound, robotUser),
      async (job) => {
        const outcome = await actor.sendMessage(job.data.messageId);
        if (outcome === 'BLOCKED_KILL_SWITCH') {
          throw new ActionBlockedError('KillSwitch activo');
        }
        logger.info({ messageId: job.data.messageId, outcome }, 'envío procesado');
        return outcome;
      },
      { connection: { url: redisUrl }, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      logger.warn({ messageId: job?.data.messageId, err: err.name }, 'envío no completado');
    });
  }

  async close() {
    await this.worker.close();
  }
}
