import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { loadConfig, requireAbayaConfig } from '@abaya/config';
import { FieldCipher, totp } from '@abaya/crypto';
import { createPrismaClient } from '@abaya/db';
import { createLogger } from '@abaya/logger';
import { ActorGate } from '../actor/actor-gate.js';
import { LogAlertAdapter } from '../alerts/log-alert.adapter.js';
import { PlaywrightSessionDriver } from './playwright-session-driver.js';
import { SessionManager } from './session-manager.js';
import { PrismaSessionRepository, type SessionStatus } from './session.repository.js';
import { EncryptedFileStorageStateStore } from './storage-state.store.js';

/**
 * Arranca la sesión del usuario robot si Abaya está configurado. Sin ABAYA_BASE_URL el
 * proceso rpa queda en modo inactivo (útil en desarrollo).
 */
@Injectable()
export class SessionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = createLogger('rpa.session');
  readonly gate = new ActorGate();
  private manager?: SessionManager;
  private driver?: PlaywrightSessionDriver;

  async onModuleInit() {
    const cfg = loadConfig();
    if (!cfg.ABAYA_BASE_URL) {
      this.logger.warn('ABAYA_BASE_URL no configurada: sesión deshabilitada');
      return;
    }
    const abaya = requireAbayaConfig(cfg);
    this.driver = new PlaywrightSessionDriver({ baseUrl: abaya.baseUrl, headless: abaya.headless });
    this.manager = new SessionManager({
      robotUser: abaya.robotUser,
      driver: this.driver,
      store: new EncryptedFileStorageStateStore(
        abaya.sessionStateDir,
        abaya.robotUser,
        new FieldCipher(cfg.FIELD_ENCRYPTION_KEY),
      ),
      repo: new PrismaSessionRepository(createPrismaClient(cfg.DATABASE_URL)),
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
  }
}
