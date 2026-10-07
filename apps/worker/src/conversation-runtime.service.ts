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
import { FallbackLlmAdapter } from './llm/adapters/fallback.adapter.js';
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

function providerAdapter(
  cfg: AppConfig,
  provider: AppConfig['LLM_PROVIDER'],
  model: string | undefined,
): LlmPort {
  switch (provider) {
    case 'anthropic':
      return new AnthropicLlmAdapter({
        ...(cfg.ANTHROPIC_API_KEY ? { apiKey: cfg.ANTHROPIC_API_KEY } : {}),
        ...(model ? { model } : {}),
        timeoutMs: cfg.LLM_TIMEOUT_MS,
      });
    case 'openai':
      if (!model) throw new Error('Falta el modelo de OpenAI (LLM_MODEL o LLM_FALLBACK_MODEL)');
      return new OpenAiLlmAdapter({
        model,
        ...(cfg.OPENAI_API_KEY ? { apiKey: cfg.OPENAI_API_KEY } : {}),
        timeoutMs: cfg.LLM_TIMEOUT_MS,
      });
    case 'simulado':
      // Solo desarrollo (la configuración lo rechaza en producción): sin red ni API key.
      return new ScriptedLlmAdapter(heuristicBrain, cfg.LLM_SIMULATED_DELAY_MS);
    default:
      throw new Error(`LLM_PROVIDER ${provider} sin adaptador todavía`);
  }
}

/** Proveedor principal y, si está configurado, uno de respaldo (v1.5). */
function llmFromConfig(cfg: AppConfig): LlmPort {
  const primary = providerAdapter(cfg, cfg.LLM_PROVIDER, cfg.LLM_MODEL);
  if (!cfg.LLM_FALLBACK_PROVIDER || cfg.LLM_PROVIDER === 'simulado') return primary;
  const backup = providerAdapter(cfg, cfg.LLM_FALLBACK_PROVIDER, cfg.LLM_FALLBACK_MODEL);
  return new FallbackLlmAdapter(primary, backup, createLogger('worker.llm'));
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
      engine: new ConversationEngine({
        llm: llmFromConfig(cfg),
        catalog,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
      }),
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
      databaseChecks(prisma, {
        maxChatsPerRobot: cfg.MAX_CHATS_PER_ROBOT,
        responseP95AlertMs: cfg.RESPONSE_P95_ALERT_MS,
      }),
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
