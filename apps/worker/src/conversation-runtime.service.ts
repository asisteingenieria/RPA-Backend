import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { loadConfig, type AppConfig } from '@abaya/config';
import { FieldCipher } from '@abaya/crypto';
import { createPrismaClient, type PrismaClient } from '@abaya/db';
import { QUEUES, type AlertPort, type InboundJob, type LlmPort } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { Worker } from 'bullmq';
import { PrismaCatalog } from './catalog/catalog.js';
import { PrismaConversationStore } from './conversation/prisma.store.js';
import { TurnScheduler } from './conversation/turn-scheduler.js';
import { TurnService } from './conversation/turn.service.js';
import { ConversationEngine } from './engine/conversation-engine.js';
import { AnthropicLlmAdapter } from './llm/adapters/anthropic.adapter.js';
import { OpenAiLlmAdapter } from './llm/adapters/openai.adapter.js';
import { BullQueuePublisher, OutboxPublisher } from './outbox/outbox-publisher.js';

function llmFromConfig(cfg: AppConfig): LlmPort {
  switch (cfg.LLM_PROVIDER) {
    case 'anthropic':
      return new AnthropicLlmAdapter({
        ...(cfg.ANTHROPIC_API_KEY ? { apiKey: cfg.ANTHROPIC_API_KEY } : {}),
        ...(cfg.LLM_MODEL ? { model: cfg.LLM_MODEL } : {}),
      });
    case 'openai':
      if (!cfg.LLM_MODEL) throw new Error('LLM_MODEL es obligatorio con LLM_PROVIDER=openai');
      return new OpenAiLlmAdapter({
        model: cfg.LLM_MODEL,
        ...(cfg.OPENAI_API_KEY ? { apiKey: cfg.OPENAI_API_KEY } : {}),
      });
    default:
      throw new Error(`LLM_PROVIDER ${cfg.LLM_PROVIDER} sin adaptador todavía`);
  }
}

/**
 * Proceso worker: consume `abaya.inbound`, agrupa ráfagas, corre el motor de conversación
 * y publica las acciones vía outbox.
 */
@Injectable()
export class ConversationRuntimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = createLogger('worker');
  private prisma?: PrismaClient;
  private scheduler?: TurnScheduler;
  private inbound?: Worker<InboundJob>;
  private outbox?: OutboxPublisher;
  private publisher?: BullQueuePublisher;

  async onModuleInit() {
    const cfg = loadConfig();
    this.prisma = createPrismaClient(cfg.DATABASE_URL);
    const cipher = new FieldCipher(cfg.FIELD_ENCRYPTION_KEY);
    const catalog = new PrismaCatalog(this.prisma);
    const alerts: AlertPort = {
      raise: async (code, severity, detail) => {
        this.logger.error({ alert: code, severity, ...detail }, `ALERTA ${severity}: ${code}`);
      },
    };
    const turns = new TurnService({
      store: new PrismaConversationStore(this.prisma, cipher),
      engine: new ConversationEngine({ llm: llmFromConfig(cfg), catalog }),
      catalog,
      alerts,
      logger: createLogger('worker.turn'),
    });
    this.scheduler = new TurnScheduler((id) => turns.handle(id), {
      quietMs: cfg.BURST_QUIET_MS,
      onError: (id, err) =>
        this.logger.error(
          { conversationId: id, err: err instanceof Error ? err.name : 'unknown' },
          'error en turno',
        ),
    });
    // Concurrencia alta: recibir el mensaje solo programa el turno; no toca Abaya.
    this.inbound = new Worker<InboundJob>(
      QUEUES.inbound,
      async (job) => this.scheduler!.notify(job.data.conversationId),
      { connection: { url: cfg.REDIS_URL }, concurrency: 50 },
    );
    this.publisher = new BullQueuePublisher(cfg.REDIS_URL);
    this.outbox = new OutboxPublisher(this.prisma, this.publisher, createLogger('worker.outbox'));
    this.outbox.start();
    this.logger.info(
      { llm: cfg.LLM_PROVIDER, model: cfg.LLM_MODEL ?? 'por defecto' },
      'worker listo',
    );
  }

  async onApplicationShutdown() {
    await this.inbound?.close();
    await this.scheduler?.stop();
    await this.outbox?.stop();
    await this.publisher?.close();
    await this.prisma?.$disconnect();
  }
}
