import { QUEUES, type InboundJob } from '@abaya/domain';
import { Queue } from 'bullmq';

export interface InboundQueue {
  enqueue(job: InboundJob): Promise<void>;
  close(): Promise<void>;
}

export class BullInboundQueue implements InboundQueue {
  private readonly queue: Queue<InboundJob>;

  constructor(redisUrl: string) {
    this.queue = new Queue<InboundJob>(QUEUES.inbound, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });
  }

  async enqueue(job: InboundJob) {
    // jobId = id del mensaje (o de la apertura del caso, D-017): segunda barrera contra duplicados.
    await this.queue.add(job.opening ? 'opening' : 'message', job, {
      jobId: job.messageId ?? `open-${job.conversationId}`,
    });
  }

  async close() {
    await this.queue.close();
  }
}

export class MemoryInboundQueue implements InboundQueue {
  readonly jobs: InboundJob[] = [];
  async enqueue(job: InboundJob) {
    this.jobs.push(job);
  }
  async close() {}
}
