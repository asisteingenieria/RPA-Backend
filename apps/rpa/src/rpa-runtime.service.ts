import { QUEUES, robotQueue } from '@abaya/domain';
import { Queue } from 'bullmq';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { loadConfig, requireAbayaConfig } from '@abaya/config';
import { FieldCipher, totp } from '@abaya/crypto';
import { createPrismaClient, type PrismaClient } from '@abaya/db';
import { createLogger } from '@abaya/logger';
import { ActorGate } from './actor/actor-gate.js';
import { BrowserActor } from './actor/browser-actor.js';
import { alertsFromConfig } from '@abaya/alerts';
import { InboundProcessor } from './inbound/inbound-processor.js';
import { BullInboundQueue, type InboundQueue } from './inbound/inbound-queue.js';
import { InboundWatcher } from './inbound/inbound-watcher.js';
import { PrismaInboundRepository } from './inbound/inbound.repository.js';
import { PrismaActionLog } from './audit/action-log.js';
import { HandoffConsumers } from './handoff/handoff-consumers.js';
import { HandoffProcessor } from './handoff/handoff-processor.js';
import { PrismaHandoffRepository } from './handoff/handoff.repository.js';
import { OutboundConsumer } from './outbound/outbound-consumer.js';
import { PrismaOutboundRepository } from './outbound/outbound.repository.js';
import { PrismaRecoveryRepository, RecoveryService } from './recovery/recovery.service.js';
import { ChatIdentityGuard } from './safety/chat-identity-guard.js';
import { RedisKillSwitch } from './safety/kill-switch.js';
import { PlaywrightTraceRecorder, cleanupTraces } from './observability/trace-recorder.js';
import { runSmokeTest } from './observability/smoke-test.js';
import { PlaywrightSessionDriver } from './session/playwright-session-driver.js';
import { SessionManager } from './session/session-manager.js';
import { PrismaSessionRepository, type SessionStatus } from './session/session.repository.js';
import { EncryptedFileStorageStateStore } from './session/storage-state.store.js';

/**
 * Arranca la sesión del usuario robot y la lectura de mensajes si Abaya está configurado.
 * Sin ABAYA_BASE_URL el proceso rpa queda en modo inactivo (útil en desarrollo).
 */
@Injectable()
export class RpaRuntimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = createLogger('rpa.session');
  readonly gate = new ActorGate();
  private manager?: SessionManager;
  private driver?: PlaywrightSessionDriver;
  private prisma?: PrismaClient;
  private inboundQueue?: InboundQueue;
  private killSwitch?: RedisKillSwitch;
  private outboundConsumer?: OutboundConsumer;
  private handoffConsumers?: HandoffConsumers;
  private recoveryQueue?: Queue;
  private recovery?: RecoveryService;
  private timers: NodeJS.Timeout[] = [];
  actor?: BrowserActor;

  async onModuleInit() {
    const cfg = loadConfig();
    if (!cfg.ABAYA_BASE_URL) {
      this.logger.warn('ABAYA_BASE_URL no configurada: sesión deshabilitada');
      return;
    }
    const abaya = requireAbayaConfig(cfg);
    const cipher = new FieldCipher(cfg.FIELD_ENCRYPTION_KEY);
    const alerts = alertsFromConfig(cfg, createLogger('rpa.alerts'));
    this.prisma = createPrismaClient(cfg.DATABASE_URL);
    this.inboundQueue = new BullInboundQueue(cfg.REDIS_URL);

    const processor = new InboundProcessor({
      robotUser: abaya.robotUser,
      repo: new PrismaInboundRepository(this.prisma),
      queue: this.inboundQueue,
      cipher,
      logger: createLogger('rpa.inbound'),
    });
    const watcher = new InboundWatcher(processor, createLogger('rpa.inbound'));

    this.driver = new PlaywrightSessionDriver({ baseUrl: abaya.baseUrl, headless: abaya.headless });
    this.driver.onPage = (page) => watcher.attach(page);

    this.manager = new SessionManager({
      robotUser: abaya.robotUser,
      driver: this.driver,
      store: new EncryptedFileStorageStateStore(abaya.sessionStateDir, abaya.robotUser, cipher),
      repo: new PrismaSessionRepository(this.prisma),
      alerts,
      gate: this.gate,
      logger: this.logger,
      credentials: () => ({
        username: abaya.robotUser,
        password: abaya.password,
        ...(abaya.mfaMode === 'totp' && abaya.totpSecret ? { otp: totp(abaya.totpSecret) } : {}),
      }),
      heartbeatMs: abaya.heartbeatMs,
      onRecovered: () => this.reconcile(),
    });
    this.killSwitch = RedisKillSwitch.fromUrl(cfg.REDIS_URL);
    const driver = this.driver;
    this.actor = new BrowserActor({
      robotUser: abaya.robotUser,
      page: () => driver.page,
      gate: this.gate,
      killSwitch: this.killSwitch,
      guard: new ChatIdentityGuard(),
      actionLog: new PrismaActionLog(this.prisma),
      outbound: new PrismaOutboundRepository(this.prisma),
      cipher,
      alerts,
      logger: createLogger('rpa.actor'),
      tracer: new PlaywrightTraceRecorder(
        () => driver.currentContext,
        abaya.traceDir,
        cipher,
        (stage, err) =>
          this.logger.warn(
            { stage, err: err instanceof Error ? err.message : 'error' },
            'falla de traza',
          ),
      ),
    });
    this.outboundConsumer = new OutboundConsumer(
      cfg.REDIS_URL,
      abaya.robotUser,
      this.actor,
      createLogger('rpa.outbound'),
    );
    this.handoffConsumers = new HandoffConsumers(
      cfg.REDIS_URL,
      abaya.robotUser,
      new HandoffProcessor({
        actor: this.actor,
        repo: new PrismaHandoffRepository(this.prisma, cipher),
        alerts,
        logger: createLogger('rpa.handoff'),
      }),
      createLogger('rpa.handoff'),
    );
    this.recoveryQueue = new Queue(robotQueue(QUEUES.outbound, abaya.robotUser), {
      connection: { url: cfg.REDIS_URL },
    });
    const recoveryQueue = this.recoveryQueue;
    const actor = this.actor;
    this.recovery = new RecoveryService({
      robotUser: abaya.robotUser,
      repo: new PrismaRecoveryRepository(this.prisma),
      inboxChatIds: () => actor.readInboxChatIds(),
      // jobId fijo por mensaje: no se apilan reencolados; el actor es idempotente.
      enqueueOutbound: async (messageId, abayaChatId) => {
        await recoveryQueue.add(
          'message',
          { messageId, abayaChatId },
          { jobId: `recover-${messageId}` },
        );
      },
      alerts,
      logger: createLogger('rpa.recovery'),
    });

    // Prueba de humo cada 15 min y limpieza diaria de trazas (sección 8: máximo 7 días).
    const manager = this.manager;
    this.timers.push(
      setInterval(() => {
        void runSmokeTest({
          sessionStatus: () => manager.status,
          readInbox: () => actor.readInboxChatIds(),
          alerts,
          robotUser: abaya.robotUser,
        });
      }, 15 * 60_000),
      setInterval(() => void cleanupTraces(abaya.traceDir, 7), 24 * 3_600_000),
    );
    void cleanupTraces(abaya.traceDir, 7);

    // No bloquear el arranque del proceso (y de /health) mientras se hace login.
    void this.manager
      .start()
      .then((status) => (status === 'ACTIVE' ? this.reconcile() : undefined))
      .catch((err: unknown) => {
        this.logger.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'fallo al iniciar sesión',
        );
      });
  }

  private async reconcile() {
    try {
      await this.recovery?.run();
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'error en reconciliación',
      );
    }
  }

  get status(): SessionStatus | 'DISABLED' {
    return this.manager?.status ?? 'DISABLED';
  }

  get playwrightDriver(): PlaywrightSessionDriver | undefined {
    return this.driver;
  }

  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    await this.outboundConsumer?.close();
    await this.handoffConsumers?.close();
    await this.recoveryQueue?.close();
    await this.manager?.stop();
    await this.killSwitch?.close();
    await this.inboundQueue?.close();
    await this.prisma?.$disconnect();
  }
}
