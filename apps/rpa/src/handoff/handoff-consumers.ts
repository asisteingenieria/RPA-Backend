import { QUEUES, robotQueue, type CloseJob, type TransferJob } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import { DelayedError, Worker, type Job } from 'bullmq';
import type { HandoffDecision, HandoffProcessor } from './handoff-processor.js';

const WAIT_MS = 2_000;
const BLOCKED_MS = 30_000;
const RETRY_MS = 10_000;

/**
 * Consumidores de `abaya.transfer` y `abaya.close`. Las acciones van al BrowserActor, que
 * las serializa con los envíos (una sola pantalla activa).
 * - WAIT / BLOCKED: se reprograma el trabajo sin consumir intentos.
 * - RETRY: se reprograma y se cuenta el intento (máximo 2 reintentos, sección 6.5).
 * - DONE / NEEDS_REVIEW: el trabajo termina.
 */
export class HandoffConsumers {
  private readonly workers: Worker[];

  constructor(redisUrl: string, robotUser: string, processor: HandoffProcessor, logger: Logger) {
    const connection = { url: redisUrl };
    const transfer = new Worker<TransferJob & { retries?: number }>(
      robotQueue(QUEUES.transfer, robotUser),
      async (job, token) => {
        const retries = job.data.retries ?? 0;
        const decision = await processor.transfer(job.data, retries);
        await this.apply(job, token, decision, logger, { ...job.data, retries: retries + 1 });
        return decision;
      },
      { connection, concurrency: 1 },
    );
    const close = new Worker<CloseJob>(
      robotQueue(QUEUES.close, robotUser),
      async (job, token) => {
        const decision = await processor.close(job.data);
        await this.apply(job, token, decision, logger, job.data);
        return decision;
      },
      { connection, concurrency: 1 },
    );
    this.workers = [transfer, close];
  }

  private async apply<T>(
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

  async close() {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
