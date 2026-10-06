import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { loadConfig, type AppConfig } from '@abaya/config';
import { cipherFromConfig } from '@abaya/crypto';
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
import { heuristicBrain } from './llm/adapters/heuristic-brain.js';
import { ScriptedLlmAdapter } from './llm/adapters/scripted.adapter.js';
import { BullQueuePublisher, OutboxPublisher } from './outbox/outbox-publisher.js';
import {
  AlertMonitor,
  closeInactive,
  conversationsWithPendingInbound,
  databaseChecks,
} from './maintenance/maintenance.js';
import { alertsFromConfig } from '@abaya/alerts';

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
    case 'simulado':
      // Solo desarrollo (la configuración lo rechaza en producción): sin red ni API key.
      return new ScriptedLlmAdapter(heuristicBrain);
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
  private timers: NodeJS.Timeout[] = [];

  async onModuleInit() {
    const cfg = loadConfig();
    this.prisma = createPrismaClient(cfg.DATABASE_URL);
    const cipher = cipherFromConfig(cfg);
    const catalog = new PrismaCatalog(this.prisma);
    const alerts: AlertPort = alertsFromConfig(cfg, createLogger('worker.alerts'));
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

    // Recuperación: retomar las conversaciones con mensajes sin atender (reinicio a mitad de turno).
    const pending = await conversationsWithPendingInbound(this.prisma);
    for (const id of pending) this.scheduler.notify(id);
    if (pending.length) this.logger.info({ count: pending.length }, 'conversaciones retomadas');

    const prisma = this.prisma;
    const monitor = new AlertMonitor(
      databaseChecks(prisma),
      alerts,
      createLogger('worker.monitor'),
    );
    this.timers.push(
      setInterval(() => void monitor.tick(), 60_000),
      setInterval(() => {
        closeInactive(prisma, new Date(), cfg.INACTIVITY_MINUTES)
          .then(
            (n) => n && this.logger.info({ closed: n }, 'conversaciones cerradas por inactividad'),
          )
          .catch((err: unknown) =>
            this.logger.error(
              { err: err instanceof Error ? err.name : 'unknown' },
              'error en inactividad',
            ),
          );
      }, 5 * 60_000),
    );
    this.logger.info(
      { llm: cfg.LLM_PROVIDER, model: cfg.LLM_MODEL ?? 'por defecto' },
      'worker listo',
    );
  }

  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    await this.inbound?.close();
    await this.scheduler?.stop();
    await this.outbox?.stop();
    await this.publisher?.close();
    await this.prisma?.$disconnect();
  }
}
