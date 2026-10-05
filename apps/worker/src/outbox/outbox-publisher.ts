import type { PrismaClient } from '@abaya/db';
import { QUEUES, type CloseJob, type OutboundJob, type TransferJob } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import { Queue } from 'bullmq';

export interface QueuePublisher {
  publish(queue: string, jobId: string, data: object): Promise<void>;
  close(): Promise<void>;
}

export class BullQueuePublisher implements QueuePublisher {
  private readonly queues = new Map<string, Queue>();
  constructor(private readonly redisUrl: string) {}

  async publish(queue: string, jobId: string, data: object) {
    let q = this.queues.get(queue);
    if (!q) {
      q = new Queue(queue, {
        connection: { url: this.redisUrl },
        defaultJobOptions: {
          attempts: 20,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      });
      this.queues.set(queue, q);
    }
    // jobId = id del evento de outbox: publicar dos veces no duplica el trabajo.
    await q.add(queue, data, { jobId });
  }

  async close() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** Traduce un evento de outbox al trabajo de cola correspondiente (o a ninguno). */
export function routeEvent(
  type: string,
  payload: Record<string, unknown>,
): { queue: string; data: OutboundJob | TransferJob | CloseJob } | null {
  switch (type) {
    case 'ReplyReady':
      return {
        queue: QUEUES.outbound,
        data: { messageId: String(payload.messageId), abayaChatId: String(payload.abayaChatId) },
      };
    case 'TransferRequested':
      return {
        queue: QUEUES.transfer,
        data: {
          conversationId: String(payload.conversationId),
          abayaChatId: String(payload.abayaChatId),
          target: payload.target === 'HUMAN' ? 'HUMAN' : 'BACKOFFICE',
          afterMessageIds: (payload.afterMessageIds as string[] | undefined) ?? [],
        },
      };
    case 'ConversationClosed':
      return {
        queue: QUEUES.close,
        data: {
          conversationId: String(payload.conversationId),
          abayaChatId: String(payload.abayaChatId),
          reason: payload.reason as CloseJob['reason'],
          afterMessageIds: (payload.afterMessageIds as string[] | undefined) ?? [],
        },
      };
    default:
      return null; // SaleCompleted, NeedsReview: métricas y auditoría, sin acción en Abaya.
  }
}

/**
 * Publicador del Transactional Outbox: lee eventos no publicados en orden y los envía a
 * las colas. Si se cae entre publicar y marcar, el jobId evita duplicados al reintentar.
 */
export class OutboxPublisher {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: QueuePublisher,
    private readonly logger: Logger,
    private readonly intervalMs = 500,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async stop() {
    clearInterval(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
  }

  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const events = await this.prisma.outboxEvent.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      for (const e of events) {
        const route = routeEvent(e.type, e.payload as Record<string, unknown>);
        if (route) await this.publisher.publish(route.queue, e.id, route.data);
        await this.prisma.outboxEvent.update({
          where: { id: e.id },
          data: { publishedAt: new Date() },
        });
      }
      return events.length;
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'error publicando outbox',
      );
      return 0;
    } finally {
      this.busy = false;
    }
  }
}
