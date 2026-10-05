import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { loadConfig, requireAbayaConfig } from '@abaya/config';
import { FieldCipher, totp } from '@abaya/crypto';
import { createPrismaClient, type PrismaClient } from '@abaya/db';
import { createLogger } from '@abaya/logger';
import { ActorGate } from '../actor/actor-gate.js';
import { LogAlertAdapter } from '../alerts/log-alert.adapter.js';
import { InboundProcessor } from '../inbound/inbound-processor.js';
import { BullInboundQueue, type InboundQueue } from '../inbound/inbound-queue.js';
import { InboundWatcher } from '../inbound/inbound-watcher.js';
import { PrismaInboundRepository } from '../inbound/inbound.repository.js';
import { PlaywrightSessionDriver } from './playwright-session-driver.js';
import { SessionManager } from './session-manager.js';
import { PrismaSessionRepository, type SessionStatus } from './session.repository.js';
import { EncryptedFileStorageStateStore } from './storage-state.store.js';

/**
 * Arranca la sesión del usuario robot y la lectura de mensajes si Abaya está configurado.
 * Sin ABAYA_BASE_URL el proceso rpa queda en modo inactivo (útil en desarrollo).
 */
@Injectable()
export class SessionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = createLogger('rpa.session');
  readonly gate = new ActorGate();
  private manager?: SessionManager;
  private driver?: PlaywrightSessionDriver;
  private prisma?: PrismaClient;
  private inboundQueue?: InboundQueue;

  async onModuleInit() {
    const cfg = loadConfig();
    if (!cfg.ABAYA_BASE_URL) {
      this.logger.warn('ABAYA_BASE_URL no configurada: sesión deshabilitada');
      return;
    }
    const abaya = requireAbayaConfig(cfg);
    const cipher = new FieldCipher(cfg.FIELD_ENCRYPTION_KEY);
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
      alerts: new LogAlertAdapter(),
      gate: this.gate,
      logger: this.logger,
      credentials: () => ({
        username: abaya.robotUser,
        password: abaya.password,
        ...(abaya.mfaMode === 'totp' && abaya.totpSecret ? { otp: totp(abaya.totpSecret) } : {}),
      }),
      heartbeatMs: abaya.heartbeatMs,
    });
    // No bloquear el arranque del proceso (y de /health) mientras se hace login.
    void this.manager.start().catch((err: unknown) => {
      this.logger.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'fallo al iniciar sesión',
      );
    });
  }

  get status(): SessionStatus | 'DISABLED' {
    return this.manager?.status ?? 'DISABLED';
  }

  get playwrightDriver(): PlaywrightSessionDriver | undefined {
    return this.driver;
  }

  async onApplicationShutdown() {
    await this.manager?.stop();
    await this.inboundQueue?.close();
    await this.prisma?.$disconnect();
  }
}
