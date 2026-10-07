import { fileURLToPath } from 'node:url';
import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadConfig } from '@abaya/config';
import { cipherFromConfig } from '@abaya/crypto';
import { createPrismaClient } from '@abaya/db';
import { AdminAuthGuard } from './admin/admin-auth.guard.js';
import { AdminController } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { AgentConfigController } from './admin/agent-config.controller.js';
import { AgentConfigService } from './admin/agent-config.service.js';
import { KnowledgeController } from './admin/knowledge.controller.js';
import { KnowledgeService } from './admin/knowledge.service.js';
import {
  embeddingsFromConfig,
  KnowledgeRetriever,
  PgBlobStore,
  PgHybridSearch,
  type KnowledgeIngestJob,
} from '@abaya/knowledge';
import { QUEUES, type AgentTestJob, type AgentTestResult, type EvalJob } from '@abaya/domain';
import { Queue, QueueEvents } from 'bullmq';
import { AuthController, COOKIE_SECURE } from './admin/auth.controller.js';
import { RedisFlagStore } from './admin/flags.js';
import { UsersController } from './admin/users.controller.js';
import { UsersService } from './admin/users.service.js';
import { HealthController } from './health/health.controller.js';
import { alertsFromConfig } from '@abaya/alerts';
import { createLogger } from '@abaya/logger';
import { RobotGatewayController } from './robots/gateway/gateway.controller.js';
import { RobotGateway } from './robots/gateway/robot-gateway.service.js';
import type { HubDeps } from './robots/gateway/ws-hub.js';
import { ROBOT_PACKAGE_FILE, RobotsController } from './robots/robots.controller.js';
import { ReleaseService } from './robots/release.service.js';
import { RobotAccessTokens } from './robots/robot-tokens.js';
import { RobotsService } from './robots/robots.service.js';

const cfg = loadConfig();
const prisma = createPrismaClient(cfg.DATABASE_URL);
const flags = new RedisFlagStore(cfg.REDIS_URL);

// Servidor padre (v1.4) y pasarela de robots hijos (v1.6, sección 2.8).
const cipher = cipherFromConfig(cfg);
const alerts = alertsFromConfig(cfg, createLogger('api.alerts'));
const packageFile =
  cfg.ROBOT_PACKAGE_FILE ??
  fileURLToPath(new URL('../../../dist/robot-package/abaya-robot-windows.zip', import.meta.url));
const release = new ReleaseService(
  packageFile,
  cfg.ROBOT_RELEASE_PUBLIC_KEY ??
    fileURLToPath(new URL('../../rpa/release-key.pub', import.meta.url)),
);
const robots = new RobotsService(
  prisma,
  flags,
  cipher,
  {
    nodeEnv: cfg.NODE_ENV,
    abayaBaseUrl: cfg.ABAYA_BASE_URL,
    heartbeatMs: cfg.HEARTBEAT_INTERVAL_MS,
  },
  {
    maxChatsPerRobot: cfg.MAX_CHATS_PER_ROBOT,
    tokens: new RobotAccessTokens(cfg.FIELD_ENCRYPTION_KEY, Date.now, cfg.ROBOT_ACCESS_TTL_MS),
    alerts,
    release,
  },
);
const gateway = new RobotGateway({
  prisma,
  cipher,
  redisUrl: cfg.REDIS_URL,
  alerts,
  traceDir: cfg.TRACE_DIR,
});
/** Lo que necesita el WebSocket de la pasarela (lo monta main.ts sobre el servidor HTTP). */
export const hubDeps: HubDeps = {
  robots,
  prisma,
  flags,
  redisUrl: cfg.REDIS_URL,
  logger: createLogger('api.gateway'),
  release,
};
// Configuración del agente (v1.8): publicar encola la suite de evaluación en el worker.
const evalQueue = new Queue<EvalJob>(QUEUES.evals, { connection: { url: cfg.REDIS_URL } });
const testQueue = new Queue<AgentTestJob>(QUEUES.agentTest, { connection: { url: cfg.REDIS_URL } });
const testEvents = new QueueEvents(QUEUES.agentTest, { connection: { url: cfg.REDIS_URL } });
const ingestQueue = new Queue<KnowledgeIngestJob>(QUEUES.knowledgeIngest, {
  connection: { url: cfg.REDIS_URL },
});
// Brains (v1.9): fuentes cifradas en PostgreSQL, ingesta y publicación (con la suite) en el worker.
// Mismo bloqueo de publicación que el agente (proveedor real y API key).
const knowledge: KnowledgeService = new KnowledgeService(
  prisma,
  new PgBlobStore(prisma, cipher),
  {
    ingest: async (job) => {
      await ingestQueue.add('ingest', job, {
        jobId: `ingest-${job.sourceId}-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    },
    evaluate: async (job) => {
      await evalQueue.add('evaluate', job, {
        jobId: `brain-${job.versionId}-${Date.now()}`,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    },
  },
  {
    publishBlocker: (): string | null => agentConfig.publishBlocker(),
    maxFileBytes: cfg.KNOWLEDGE_MAX_FILE_MB * 1024 * 1024,
    // Prueba de búsqueda en el panel: mismo recuperador que usa el motor.
    retriever: new KnowledgeRetriever(
      prisma,
      new PgHybridSearch(prisma),
      embeddingsFromConfig(cfg),
      {
        topK: cfg.KNOWLEDGE_SEARCH_TOP_K,
        fullContextBudget: cfg.KNOWLEDGE_FULL_CONTEXT_MAX_TOKENS * 2,
      },
    ),
  },
);
const agentConfig: AgentConfigService = new AgentConfigService(
  prisma,
  {
    provider: cfg.LLM_PROVIDER,
    defaultModel: cfg.LLM_MODEL ?? null,
    allowedModels: cfg.LLM_ALLOWED_MODELS,
    providerReady:
      cfg.LLM_PROVIDER === 'anthropic'
        ? !!cfg.ANTHROPIC_API_KEY
        : cfg.LLM_PROVIDER === 'openai'
          ? !!cfg.OPENAI_API_KEY
          : cfg.LLM_PROVIDER !== 'gemini',
  },
  {
    enqueue: async (job) => {
      await evalQueue.add('evaluate', job, {
        jobId: `agent-${job.versionId}-${Date.now()}`,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    },
  },
  {
    // "Probar agente": el worker corre el turno y la API espera su resultado.
    run: async (job) => {
      const j = await testQueue.add('turn', job, {
        attempts: 1,
        removeOnComplete: { age: 60 },
        removeOnFail: { age: 60 },
      });
      return (await j.waitUntilFinished(testEvents, 45_000)) as AgentTestResult;
    },
  },
  () => knowledge.agentCatalogForPanel(),
);
const traceCleanup = setInterval(() => void gateway.cleanupTraces(), 6 * 3_600_000);
traceCleanup.unref();

@Module({
  controllers: [
    HealthController,
    AuthController,
    AdminController,
    UsersController,
    AgentConfigController,
    KnowledgeController,
    RobotsController,
    RobotGatewayController,
  ],
  providers: [
    { provide: AdminService, useValue: new AdminService(prisma, flags) },
    { provide: UsersService, useValue: new UsersService(prisma) },
    { provide: AgentConfigService, useValue: agentConfig },
    { provide: KnowledgeService, useValue: knowledge },
    { provide: RobotsService, useValue: robots },
    { provide: RobotGateway, useValue: gateway },
    { provide: ReleaseService, useValue: release },
    { provide: COOKIE_SECURE, useValue: cfg.ADMIN_COOKIE_SECURE },
    { provide: ROBOT_PACKAGE_FILE, useValue: packageFile },
    AdminAuthGuard,
  ],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    clearInterval(traceCleanup);
    await gateway.close();
    await evalQueue.close();
    await testQueue.close();
    await ingestQueue.close();
    await testEvents.close();
    await flags.close();
    await prisma.$disconnect();
  }
}
