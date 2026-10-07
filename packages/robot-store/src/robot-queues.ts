import {
  QUEUES,
  robotQueue,
  type CloseJob,
  type OutboundJob,
  type TransferJob,
} from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import { DelayedError, Worker, type Job } from 'bullmq';

/** Qué hacer con un trabajo de transferencia o cierre (lo decide el HandoffProcessor). */
export type HandoffDecision = 'DONE' | 'WAIT' | 'RETRY' | 'BLOCKED' | 'NEEDS_REVIEW';

/** Resultado de un envío que obliga a reintentar más tarde (kill switch o pausa). */
export const SEND_BLOCKED = 'BLOCKED_KILL_SWITCH';

export class ActionBlockedError extends Error {
  override name = 'ActionBlockedError';
}

/**
 * Quién ejecuta las tareas del robot. En modo directo, el BrowserActor del propio proceso;
 * en un robot hijo (v1.6), el servidor se las reenvía al equipo por WebSocket.
 */
export interface RobotQueueHandlers {
  send(messageId: string): Promise<string>;
  transfer(job: TransferJob, retries: number): Promise<HandoffDecision>;
  close(job: CloseJob): Promise<HandoffDecision>;
}

const WAIT_MS = 2_000;
const BLOCKED_MS = 30_000;
const RETRY_MS = 10_000;

/**
 * Consumidores de las colas de UN robot (`abaya.outbound|transfer|close.<robot>`), cada uno
 * con concurrencia 1; el BrowserActor serializa entre ellos (una sola pantalla).
 * - Envío bloqueado por kill switch: el trabajo falla y la cola lo reintenta más tarde.
 * - UNCERTAIN: el trabajo termina; nunca se reintenta solo (regla 2).
 * - Transferencia/cierre: WAIT y BLOCKED se reprograman sin gastar intentos; RETRY gasta uno
 *   (máximo 2 reintentos, sección 6.5); DONE y NEEDS_REVIEW terminan.
 */
export class RobotQueueConsumers {
  private readonly workers: Worker[];

  constructor(redisUrl: string, robotUser: string, h: RobotQueueHandlers, logger: Logger) {
    const connection = { url: redisUrl };
    const outbound = new Worker<OutboundJob>(
      robotQueue(QUEUES.outbound, robotUser),
      async (job) => {
        const outcome = await h.send(job.data.messageId);
        if (outcome === SEND_BLOCKED) throw new ActionBlockedError('KillSwitch activo');
        logger.info({ messageId: job.data.messageId, outcome }, 'envío procesado');
        return outcome;
      },
      { connection, concurrency: 1 },
    );
    outbound.on('failed', (job, err) => {
      logger.warn({ messageId: job?.data.messageId, err: err.name }, 'envío no completado');
    });
    const transfer = new Worker<TransferJob & { retries?: number }>(
      robotQueue(QUEUES.transfer, robotUser),
      async (job, token) => {
        const retries = job.data.retries ?? 0;
        const decision = await h.transfer(job.data, retries);
        await apply(job, token, decision, logger, { ...job.data, retries: retries + 1 });
        return decision;
      },
      { connection, concurrency: 1 },
    );
    const close = new Worker<CloseJob>(
      robotQueue(QUEUES.close, robotUser),
      async (job, token) => {
        const decision = await h.close(job.data);
        await apply(job, token, decision, logger, job.data);
        return decision;
      },
      { connection, concurrency: 1 },
    );
    this.workers = [outbound, transfer, close];
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}

async function apply<T>(
  job: Job<T>,
  token: string | undefined,
  d: HandoffDecision,
  logger: Logger,
  retryData: T,
) {
  const delay =
    d === 'WAIT' ? WAIT_MS : d === 'BLOCKED' ? BLOCKED_MS : d === 'RETRY' ? RETRY_MS : 0;
  if (!delay) return;
  if (d === 'RETRY') await job.updateData(retryData);
  logger.info({ queue: job.queueName, decision: d }, 'trabajo reprogramado');
  await job.moveToDelayed(Date.now() + delay, token);
  throw new DelayedError();
}
