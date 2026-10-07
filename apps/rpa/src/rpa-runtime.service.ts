import { randomUUID } from 'node:crypto';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { totp } from '@abaya/crypto';
import { createLogger } from '@abaya/logger';
import { ActorGate } from './actor/actor-gate.js';
import { BrowserActor } from './actor/browser-actor.js';
import { getRobotBackend, type RobotBackend } from './backend/robot-backend.js';
import { HandoffProcessor } from './handoff/handoff-processor.js';
import { InboundProcessor } from './inbound/inbound-processor.js';
import { InboundWatcher } from './inbound/inbound-watcher.js';
import { MissedMessageSweeper, SWEEP_EVERY_MS } from './inbound/missed-sweeper.js';
import { EXIT, requestShutdown } from './lifecycle.js';
import { runSmokeTest } from './observability/smoke-test.js';
import { PlaywrightTraceRecorder, cleanupTraces } from './observability/trace-recorder.js';
import { uploadPendingTraces } from './observability/trace-uploader.js';
import { robotHost, robotVersion } from './presence/instance.js';
import { RobotPresence } from './presence/robot-presence.js';
import { RecoveryService } from './recovery/recovery.service.js';
import { InstallLayout, RobotUpdater } from './update/updater.js';
import { EXIT_UPDATE, verifyRelease } from '@abaya/robot-store';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ChatIdentityGuard } from './safety/chat-identity-guard.js';
import { PlaywrightSessionDriver } from './session/playwright-session-driver.js';
import { SessionManager } from './session/session-manager.js';
import type { SessionStatus } from './session/session.repository.js';
import { EncryptedFileStorageStateStore } from './session/storage-state.store.js';

/**
 * Arranca la sesión del usuario robot y la lectura de mensajes. El backend (directo o hijo
 * por la pasarela, v1.6) lo elige main.ts. Sin Abaya configurado en modo directo, el proceso
 * queda inactivo (útil en desarrollo).
 */
@Injectable()
export class RpaRuntimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = createLogger('rpa.session');
  readonly gate = new ActorGate();
  private backend?: RobotBackend;
  private manager?: SessionManager;
  private driver?: PlaywrightSessionDriver;
  private recovery?: RecoveryService;
  private timers: NodeJS.Timeout[] = [];
  private presence?: RobotPresence;
  private updater?: RobotUpdater;
  actor?: BrowserActor;

  async onModuleInit() {
    const backend = getRobotBackend();
    if (!backend) {
      this.logger.warn('ABAYA_BASE_URL no configurada: sesión deshabilitada');
      return;
    }
    this.backend = backend;
    const { abaya, alerts } = backend;

    // Un robot = un equipo a la vez (v1.4): se reclama antes de recibir tareas o tocar Abaya.
    const instanceId = randomUUID();
    this.presence = new RobotPresence({
      store: backend.presence,
      info: {
        robotUser: abaya.robotUser,
        instanceId,
        host: robotHost(backend.robotHost),
        version: robotVersion(),
      },
      alerts,
      logger: createLogger('rpa.presence'),
      // El servidor lo deshabilitó u otra instancia lo tomó: apagado ordenado del proceso.
      onEvicted: () => requestShutdown(EXIT.NO_RESTART),
    });
    await this.presence.start();

    const processor = new InboundProcessor({
      robotUser: abaya.robotUser,
      sink: backend.inbound,
      logger: createLogger('rpa.inbound'),
    });
    const watcher = new InboundWatcher(processor, createLogger('rpa.inbound'));

    this.driver = new PlaywrightSessionDriver({ baseUrl: abaya.baseUrl, headless: abaya.headless });
    this.driver.onPage = (page) => watcher.attach(page);
    const driver = this.driver;

    this.manager = new SessionManager({
      robotUser: abaya.robotUser,
      driver,
      store: new EncryptedFileStorageStateStore(
        abaya.sessionStateDir,
        abaya.robotUser,
        backend.localCipher,
      ),
      repo: backend.sessions,
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
    const manager = this.manager;

    const actor = new BrowserActor({
      robotUser: abaya.robotUser,
      page: () => driver.page,
      gate: this.gate,
      killSwitch: backend.killSwitch,
      guard: new ChatIdentityGuard(),
      actionLog: backend.actionLog,
      outbound: backend.outbound,
      alerts,
      logger: createLogger('rpa.actor'),
      tracer: new PlaywrightTraceRecorder(
        () => driver.currentContext,
        abaya.traceDir,
        backend.localCipher,
        (stage, err) =>
          this.logger.warn(
            { stage, err: err instanceof Error ? err.message : 'error' },
            'falla de traza',
          ),
      ),
    });
    this.actor = actor;
    const handoff = new HandoffProcessor({
      actor,
      repo: backend.handoff,
      alerts,
      logger: createLogger('rpa.handoff'),
    });
    await backend.startQueues(
      {
        send: (messageId) => actor.sendMessage(messageId),
        transfer: (job, retries) => handoff.transfer(job, retries),
        close: (job) => handoff.close(job),
      },
      instanceId,
    );

    this.recovery = new RecoveryService({
      robotUser: abaya.robotUser,
      repo: backend.recovery,
      inboxChatIds: () => actor.readInboxChatIds(),
      enqueueOutbound: (messageId, abayaChatId) => backend.enqueueOutbound(messageId, abayaChatId),
      alerts,
      logger: createLogger('rpa.recovery'),
    });

    // Prueba de humo cada 15 min y limpieza diaria de trazas (sección 8: máximo 7 días).
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

    // Robot hijo (v1.6): las trazas de error suben al servidor.
    if (backend.uploadTrace) {
      const upload = backend.uploadTrace.bind(backend);
      const logger = createLogger('rpa.traces');
      this.timers.push(
        setInterval(
          () => void uploadPendingTraces(abaya.traceDir, backend.localCipher, upload, logger),
          60_000,
        ),
      );
    }

    // Red de seguridad de la lectura (v1.5): chats con no leídos que el sistema no detectó.
    const sweeper = new MissedMessageSweeper({
      robotUser: abaya.robotUser,
      actor,
      repo: backend.sweep,
      logger: createLogger('rpa.inbound'),
    });
    this.timers.push(
      setInterval(() => {
        if (manager.status !== 'ACTIVE') return;
        sweeper
          .sweep()
          .catch((err: unknown) =>
            this.logger.warn(
              { err: err instanceof Error ? err.name : 'error' },
              'no se pudo revisar la bandeja',
            ),
          );
      }, SWEEP_EVERY_MS),
    );

    // Reciclaje del navegador (v1.5): tras N horas, solo con la bandeja vacía y sin acciones.
    if (backend.browserRecycleHours > 0) {
      const maxAgeMs = backend.browserRecycleHours * 3_600_000;
      this.timers.push(
        setInterval(() => {
          if (manager.status !== 'ACTIVE' || driver.browserAgeMs < maxAgeMs) return;
          void actor
            .recycleIfIdle(async () => {
              await manager.recycle();
            })
            .then((r) => {
              if (r === 'RECYCLED') return this.reconcile();
            })
            .catch((err: unknown) =>
              this.logger.warn(
                { err: err instanceof Error ? err.name : 'error' },
                'no se pudo reciclar el navegador',
              ),
            );
        }, 5 * 60_000),
      );
    }

    // Actualizaciones (v1.7, solo robot hijo instalado con versiones lado a lado).
    if (backend.updates) this.startUpdater(backend.updates, actor);

    // No bloquear el arranque del proceso (y de /health) mientras se hace login.
    void manager
      .start()
      .then(async (status) => {
        if (status !== 'ACTIVE') return;
        await this.reconcile();
        // Versión nueva a prueba: se confirma tras 2 minutos en línea.
        const updater = this.updater;
        if (updater) {
          await updater.afterStartup();
          this.timers.push(
            setTimeout(() => {
              if (manager.status === 'ACTIVE') void updater.confirmIfOnProbation();
            }, 120_000),
          );
        }
      })
      .catch((err: unknown) => {
        this.logger.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'fallo al iniciar sesión',
        );
      });
  }

  private startUpdater(updates: NonNullable<RobotBackend['updates']>, actor: BrowserActor) {
    const keyFile = fileURLToPath(new URL('../release-key.pub', import.meta.url));
    const publicKeyPem = existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : null;
    const installDir = process.env.ROBOT_INSTALL_DIR;
    const updater = new RobotUpdater({
      layout: installDir ? new InstallLayout(installDir) : null,
      currentVersion: robotVersion(),
      publicKeyPem,
      fetchManifest: () => updates.fetchManifest(),
      download: (p) => updates.download(p),
      report: (s, v, m) => updates.report(s, v, m),
      runIfIdle: (fn) => actor.runIfIdle(fn),
      restartForUpdate: () => {
        // Nada más se ejecuta en Abaya; el lanzador activa la versión nueva.
        this.gate.pause('update');
        this.logger.info('reiniciando para activar la versión nueva');
        requestShutdown(EXIT_UPDATE);
      },
      logger: createLogger('rpa.update'),
    });
    this.updater = updater;
    updates.onRequest((v) => void updater.request(v));
    // Botón local (actualizar.cmd): pide la última versión publicada (verificada).
    this.timers.push(
      setInterval(() => {
        void updater.localRequestPending().then(async (asked) => {
          if (!asked || !publicKeyPem) return;
          const m = verifyRelease(await updates.fetchManifest().catch(() => null), publicKeyPem);
          if (m) await updater.request(m.version);
          else this.logger.warn('no hay versión publicada válida para actualizar');
        });
      }, 30_000),
    );
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
    this.updater?.stop();
    await this.manager?.stop();
    await this.presence?.stop().catch(() => undefined);
    await this.backend?.close();
  }
}
