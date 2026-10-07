import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { loadConfig } from '@abaya/config';
import { cipherFromConfig } from '@abaya/crypto';
import { createPrismaClient, type PrismaClient } from '@abaya/db';
import {
  QUEUES,
  type AgentTestJob,
  type AgentTestResult,
  type AlertPort,
  type EvalJob,
  type InboundJob,
} from '@abaya/domain';
import {
  bootstrapLegacyCatalog,
  CatalogTableParser,
  ingestSource,
  PgBlobStore,
  type KnowledgeIngestJob,
} from '@abaya/knowledge';
import { createLogger } from '@abaya/logger';
import { Worker } from 'bullmq';
import { PrismaAgentConfigSource } from './catalog/agent-config.js';
import { PublishedBrainCatalog } from './catalog/catalog.js';
import { PrismaConversationStore } from './conversation/prisma.store.js';
import { TurnScheduler } from './conversation/turn-scheduler.js';
import { TurnService } from './conversation/turn.service.js';
import { ConversationEngine } from './engine/conversation-engine.js';
import { evaluateAgentVersion } from './evals/agent-evaluation.js';
import { catchUpDraft, evaluateBrainVersion } from './evals/brain-evaluation.js';
import { runAgentTest } from './evals/agent-test.js';
import { llmFromConfig, providerAdapter } from './llm/from-config.js';
import { BullQueuePublisher, OutboxPublisher } from './outbox/outbox-publisher.js';
import {
  AlertMonitor,
  closeInactive,
  conversationsWithPendingInbound,
  databaseChecks,
} from './maintenance/maintenance.js';
import { alertsFromConfig } from '@abaya/alerts';

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
  private evals?: Worker<EvalJob>;
  private agentTests?: Worker<AgentTestJob, AgentTestResult>;
  private agentSource?: PrismaAgentConfigSource;
  private catalog?: PublishedBrainCatalog;
  private ingest?: Worker<KnowledgeIngestJob>;
  private outbox?: OutboxPublisher;
  private publisher?: BullQueuePublisher;
  private timers: NodeJS.Timeout[] = [];

  async onModuleInit() {
    const cfg = loadConfig();
    this.prisma = createPrismaClient(cfg.DATABASE_URL);
    const cipher = cipherFromConfig(cfg);
    // Catálogo (v1.9): versión publicada del Brain conectado al agente. La primera vez, el
    // catálogo vigente de la tabla Plan pasa a ser la v1 del Brain (paso único, auditado).
    const migrated = await bootstrapLegacyCatalog(this.prisma);
    if (migrated.created) {
      this.logger.info(
        { plans: migrated.records },
        'catálogo de Plan pasado a Brain (v1 publicada)',
      );
    }
    this.catalog = new PublishedBrainCatalog(this.prisma, createLogger('worker.catalog'));
    await this.catalog.start();
    const catalog = this.catalog;
    const alerts: AlertPort = alertsFromConfig(cfg, createLogger('worker.alerts'));
    // Versión publicada del agente (v1.8): guion y ajustes editados en el panel.
    this.agentSource = new PrismaAgentConfigSource(this.prisma, createLogger('worker.agent'));
    await this.agentSource.start();
    const agentSource = this.agentSource;
    const turns = new TurnService({
      store: new PrismaConversationStore(this.prisma, cipher),
      engine: new ConversationEngine({
        llm: llmFromConfig(cfg),
        catalog,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
        agentConfig: () => agentSource.get(),
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
    // Publicar una versión del agente = pasar la suite de evaluación (regla 13). Una a la vez.
    const evalLogger = createLogger('worker.evals');
    const prismaForEvals = this.prisma;
    this.evals = new Worker<EvalJob>(
      QUEUES.evals,
      async (job) => {
        const deps = {
          prisma: prismaForEvals,
          provider: cfg.LLM_PROVIDER,
          llm: () => providerAdapter(cfg, cfg.LLM_PROVIDER, cfg.LLM_MODEL),
          ...(cfg.EVALS_DIR ? { casesDir: cfg.EVALS_DIR } : {}),
          logger: evalLogger,
        };
        if (job.data.kind === 'brain') {
          // Catálogo de un Brain (v1.9): misma suite, agente publicado + catálogo borrador.
          const startedAt = new Date();
          await evaluateBrainVersion(deps, job.data);
          await catchUpDraft(prismaForEvals, job.data.versionId, startedAt);
          await catalog.refresh();
          return;
        }
        await evaluateAgentVersion(deps, job.data);
        await agentSource.refresh();
      },
      { connection: { url: cfg.REDIS_URL }, concurrency: 1 },
    );
    // "Probar agente" del panel: turnos simulados, sin Abaya y sin guardar nada.
    const testLlm = llmFromConfig(cfg);
    this.agentTests = new Worker<AgentTestJob, AgentTestResult>(
      QUEUES.agentTest,
      async (job) =>
        runAgentTest({ llm: testLlm, catalog, timeoutMs: cfg.LLM_TIMEOUT_MS }, job.data),
      { connection: { url: cfg.REDIS_URL }, concurrency: 4 },
    );
    // Ingesta de fuentes de los Brains (v1.9, D9): un archivo inválido no se reintenta.
    const ingestLogger = createLogger('worker.knowledge');
    const ingestDeps = {
      prisma: this.prisma,
      blobs: new PgBlobStore(this.prisma, cipher),
      parser: new CatalogTableParser(),
      log: (msg: string, data: Record<string, unknown>) => ingestLogger.info(data, msg),
    };
    this.ingest = new Worker<KnowledgeIngestJob>(
      QUEUES.knowledgeIngest,
      async (job) => {
        await ingestSource(ingestDeps, job.data);
      },
      { connection: { url: cfg.REDIS_URL }, concurrency: 2 },
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
    this.agentSource?.stop();
    this.catalog?.stop();
    await this.ingest?.close();
    await this.evals?.close();
    await this.agentTests?.close();
    await this.inbound?.close();
    await this.scheduler?.stop();
    await this.outbox?.stop();
    await this.publisher?.close();
    await this.prisma?.$disconnect();
  }
}
