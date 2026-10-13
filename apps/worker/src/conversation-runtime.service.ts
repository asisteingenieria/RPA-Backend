import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { loadConfig } from '@abaya/config';
import { cipherFromConfig } from '@abaya/crypto';
import { createPrismaClient, PrismaUsageRecorder, type PrismaClient } from '@abaya/db';
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
  embeddingsFromConfig,
  withEmbeddingUsage,
  ingestSource,
  KnowledgeRetriever,
  PgBlobStore,
  PgHybridSearch,
  refreshDueWebSources,
  SafeWebFetcher,
  TextExtractor,
  type KnowledgeIngestJob,
} from '@abaya/knowledge';
import { PublishedKnowledge } from './knowledge/published-knowledge.js';
import { createLogger } from '@abaya/logger';
import { Worker } from 'bullmq';
import { PrismaAgentConfigSource } from './catalog/agent-config.js';
import { PublishedBrainCatalog } from './catalog/catalog.js';
import { PrismaConversationStore } from './conversation/prisma.store.js';
import { RedisRobotsPause } from './conversation/robots-pause.js';
import { TurnScheduler } from './conversation/turn-scheduler.js';
import { TurnService } from './conversation/turn.service.js';
import { ConversationEngine } from './engine/conversation-engine.js';
import { holdingTexts, reactivationTexts } from './engine/templates/templates.js';
import { evaluateAgentVersion } from './evals/agent-evaluation.js';
import { catchUpDraft, evaluateBrainVersion } from './evals/brain-evaluation.js';
import { runAgentTest } from './evals/agent-test.js';
import { llmFromConfig, providerAdapter } from './llm/from-config.js';
import { imageReaderFromConfig } from './knowledge/gemini-image-reader.js';
import { speechFromConfig } from './speech/from-config.js';
import { meteredLlm, meteredSpeech } from './usage/metered.js';
import { BullQueuePublisher, OutboxPublisher } from './outbox/outbox-publisher.js';
import {
  AlertMonitor,
  closeInactive,
  conversationsWithPendingInbound,
  databaseChecks,
  purgeExpiredConversations,
  purgeStaleVoiceAudio,
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
  private knowledge?: PublishedKnowledge;
  private ingest?: Worker<KnowledgeIngestJob>;
  private outbox?: OutboxPublisher;
  private publisher?: BullQueuePublisher;
  private timers: NodeJS.Timeout[] = [];
  private pause?: RedisRobotsPause;

  async onModuleInit() {
    const cfg = loadConfig();
    this.prisma = createPrismaClient(cfg.DATABASE_URL);
    // Vista «Consumo»: tokens de voz, imágenes, embeddings, evaluaciones y pruebas.
    const usage = new PrismaUsageRecorder(this.prisma, (err) =>
      this.logger.warn(
        { err: err instanceof Error ? err.name : 'unknown' },
        'consumo no registrado',
      ),
    );
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
    // Documentos de los Brains (K3/K4): contexto completo + búsqueda híbrida por turno.
    const rawEmbeddings = embeddingsFromConfig(cfg);
    const embeddings = rawEmbeddings ? withEmbeddingUsage(rawEmbeddings, usage) : null;
    const retriever = new KnowledgeRetriever(
      this.prisma,
      new PgHybridSearch(this.prisma),
      embeddings,
      {
        topK: cfg.KNOWLEDGE_SEARCH_TOP_K,
        fullContextBudget: cfg.KNOWLEDGE_FULL_CONTEXT_MAX_TOKENS * 2,
      },
    );
    this.knowledge = new PublishedKnowledge(
      this.prisma,
      retriever,
      createLogger('worker.knowledge'),
    );
    await this.knowledge.start();
    const knowledge = this.knowledge;
    const alerts: AlertPort = alertsFromConfig(cfg, createLogger('worker.alerts'));
    // Versión publicada del agente (v1.8): guion y ajustes editados en el panel.
    this.agentSource = new PrismaAgentConfigSource(this.prisma, createLogger('worker.agent'));
    await this.agentSource.start();
    const agentSource = this.agentSource;
    // D-009: pausados no se llama al modelo; si el proveedor no responde, se pausan los robots.
    this.pause = new RedisRobotsPause(cfg.REDIS_URL);
    const pause = this.pause;
    const store = new PrismaConversationStore(this.prisma, cipher);
    const turns = new TurnService({
      store,
      pause,
      // 13/10/2026: el robot espera en silencio a que el cliente termine de mandar sus datos.
      later: (id, ms) => {
        const t = setTimeout(() => this.scheduler?.notify(id), ms);
        t.unref?.();
      },
      // D-010: notas de voz transcritas antes del motor.
      speech: meteredSpeech(speechFromConfig(cfg), usage, 'VOICE'),
      speechTimeoutMs: cfg.STT_TIMEOUT_MS,
      maxVoiceSeconds: cfg.STT_MAX_SECONDS,
      engine: new ConversationEngine({
        llm: llmFromConfig(cfg),
        catalog,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
        // D-004: cada conversación termina con la versión con la que empezó.
        agentConfig: (s) => agentSource.resolve(s.agentVersionId),
        knowledge,
        // D-014 fase 2: con catálogo desde imágenes, ofrecer con ellas (el robot las pega).
        offerWithImages: cfg.SEND_PLAN_IMAGES,
      }),
      catalog,
      alerts,
      currentAgentVersionId: () => agentSource.get().id,
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
          llm: () =>
            meteredLlm(providerAdapter(cfg, cfg.LLM_PROVIDER, cfg.LLM_MODEL), usage, 'EVAL'),
          ...(cfg.EVALS_DIR ? { casesDir: cfg.EVALS_DIR } : {}),
          logger: evalLogger,
          retriever,
          knowledge,
        };
        if (job.data.kind === 'brain') {
          // Catálogo de un Brain (v1.9): misma suite, agente publicado + catálogo borrador.
          const startedAt = new Date();
          await evaluateBrainVersion(deps, job.data);
          await catchUpDraft(prismaForEvals, job.data.versionId, startedAt);
          await catalog.refresh();
          await knowledge.refresh();
          return;
        }
        await evaluateAgentVersion(deps, job.data);
        await agentSource.refresh();
      },
      { connection: { url: cfg.REDIS_URL }, concurrency: 1 },
    );
    // "Probar agente" del panel: turnos simulados, sin Abaya y sin guardar nada.
    const testLlm = meteredLlm(llmFromConfig(cfg), usage, 'TEST');
    const testSpeech = meteredSpeech(speechFromConfig(cfg), usage, 'TEST');
    this.agentTests = new Worker<AgentTestJob, AgentTestResult>(
      QUEUES.agentTest,
      async (job) =>
        runAgentTest(
          {
            llm: testLlm,
            catalog,
            knowledge,
            timeoutMs: cfg.LLM_TIMEOUT_MS,
            // D-010: la prueba con nota de voz usa el mismo proveedor de voz a texto.
            speech: testSpeech,
            speechTimeoutMs: cfg.STT_TIMEOUT_MS,
            maxVoiceSeconds: cfg.STT_MAX_SECONDS,
          },
          job.data,
        ),
      { connection: { url: cfg.REDIS_URL }, concurrency: 4 },
    );
    // Ingesta de fuentes de los Brains (v1.9, D9): un archivo inválido no se reintenta.
    const ingestLogger = createLogger('worker.knowledge');
    const ingestDeps = {
      prisma: this.prisma,
      blobs: new PgBlobStore(this.prisma, cipher),
      parser: new CatalogTableParser(),
      documents: new TextExtractor(),
      web: new SafeWebFetcher(),
      embeddings,
      // D-011: lectura de los planes de las imágenes (sin GEMINI_API_KEY no se pueden cargar).
      images: imageReaderFromConfig(cfg, usage),
      fullContextMaxTokens: cfg.KNOWLEDGE_FULL_CONTEXT_MAX_TOKENS,
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
    // D-009: al reanudar (panel), retomar todo lo que quedó sin responder durante la pausa.
    let wasPaused = await pause.isPaused();
    const scheduler = this.scheduler;
    const resumePending = async () => {
      const paused = await pause.isPaused();
      if (wasPaused && !paused) {
        const ids = await conversationsWithPendingInbound(prisma);
        for (const id of ids) scheduler.notify(id);
        this.logger.info({ count: ids.length }, 'robots reanudados: conversaciones retomadas');
      }
      wasPaused = paused;
    };
    // D-009: ningún chat queda sin respuesta. Si el cliente lleva HOLD_AFTER_SECONDS esperando,
    // se le avisa «dame un momento» y se vuelve a programar el turno (por si falló).
    const holdWaiting = async () => {
      if (await pause.isPaused()) return; // el rpa no enviaría nada; se retoma al reanudar
      const r = await store.queueHoldingMessages(new Date(), {
        afterMs: cfg.HOLD_AFTER_SECONDS * 1000,
        everyMs: cfg.HOLD_EVERY_SECONDS * 1000,
        max: cfg.HOLD_MAX,
        texts: holdingTexts(agentSource.get()),
      });
      for (const id of r.waiting) scheduler.notify(id);
      if (r.held)
        this.logger.warn(
          { held: r.held, waiting: r.waiting.length },
          'clientes esperando: mensaje de espera enviado',
        );
    };
    const logError = (msg: string) => (err: unknown) =>
      this.logger.error({ err: err instanceof Error ? err.name : 'unknown' }, msg);
    // D-013: si el cliente deja de responder, plantillas de reactivación de la versión publicada
    // y, agotadas, cierre por inactividad (una venta ya autorizada pasa al backoffice).
    const reactivate = async () => {
      if (await pause.isPaused()) return;
      const agent = agentSource.get();
      const now = new Date();
      const r = await store.queueReactivations(now, {
        minutes: agent.reactivation.minutes,
        max: agent.reactivation.max,
        texts: reactivationTexts(agent, now),
      });
      if (r.sent) this.logger.info({ sent: r.sent }, 'reactivación enviada');
      if (r.exhausted.length) {
        const n = await closeInactive(prisma, now, 0, r.exhausted);
        if (n) this.logger.info({ closed: n }, 'conversaciones cerradas tras la reactivación');
      }
    };

    this.timers.push(
      setInterval(() => void monitor.tick(), 60_000),
      setInterval(() => void reactivate().catch(logError('error en la reactivación')), 30_000),
      setInterval(
        () => void resumePending().catch(logError('error al retomar tras la pausa')),
        5_000,
      ),
      setInterval(() => void holdWaiting().catch(logError('error en mensajes de espera')), 30_000),
      setInterval(() => {
        // Pausados no se cierra nada: el cliente pudo escribir y el robot no podía responder.
        void pause.isPaused().then((paused) => {
          if (paused) return;
          return closeInactive(prisma, new Date(), cfg.INACTIVITY_MINUTES)
            .then(
              (n) =>
                n && this.logger.info({ closed: n }, 'conversaciones cerradas por inactividad'),
            )
            .catch(logError('error en inactividad'));
        });
      }, 5 * 60_000),
      // Retención de conversaciones (D-002): solo si Claro definió el plazo. Revisión cada hora.
      setInterval(() => {
        // D-010: el audio de una nota de voz no se conserva; si quedó sin transcribir (p. ej.
        // conversación cerrada antes del turno), se borra a las 24 h.
        purgeStaleVoiceAudio(prisma, new Date())
          .then((n) => n && this.logger.info({ purged: n }, 'audios sin transcribir borrados'))
          .catch((err: unknown) =>
            this.logger.error(
              { err: err instanceof Error ? err.name : 'unknown' },
              'error borrando audios',
            ),
          );
        const days = cfg.CONVERSATION_RETENTION_DAYS;
        if (!days) return;
        purgeExpiredConversations(prisma, new Date(), days)
          .then(
            (n) => n && this.logger.info({ purged: n, days }, 'contenido borrado por retención'),
          )
          .catch((err: unknown) =>
            this.logger.error(
              { err: err instanceof Error ? err.name : 'unknown' },
              'error en la retención de conversaciones',
            ),
          );
      }, 3_600_000),
      // Páginas web de los Brains con actualización programada (K5): revisión cada 10 min.
      setInterval(() => {
        refreshDueWebSources(ingestDeps)
          .then(
            (r) => (r.refreshed || r.failed) && ingestLogger.info(r, 'páginas web actualizadas'),
          )
          .catch((err: unknown) =>
            ingestLogger.error(
              { err: err instanceof Error ? err.name : 'unknown' },
              'error actualizando páginas web',
            ),
          );
      }, 10 * 60_000),
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
    this.knowledge?.stop();
    await this.ingest?.close();
    await this.evals?.close();
    await this.agentTests?.close();
    await this.inbound?.close();
    await this.scheduler?.stop();
    await this.outbox?.stop();
    await this.publisher?.close();
    await this.pause?.close();
    await this.prisma?.$disconnect();
  }
}
