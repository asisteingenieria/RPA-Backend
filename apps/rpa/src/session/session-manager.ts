import type { AlertPort } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import type { LoginCredentials, LoginResult } from '../abaya/pages/login.page.js';
import type { ActorGate } from '../actor/actor-gate.js';
import type { SessionDriver } from './session-driver.js';
import type { SessionRecord, SessionRepository, SessionStatus } from './session.repository.js';
import type { StorageStateStore } from './storage-state.store.js';

export const DEFAULT_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];
export const MAX_CONSECUTIVE_FAILS = 3;
const GATE_REASON = 'session';

export interface SessionManagerDeps {
  robotUser: string;
  driver: SessionDriver;
  store: StorageStateStore;
  repo: SessionRepository;
  alerts: AlertPort;
  gate: ActorGate;
  logger: Logger;
  /** Entrega credenciales en el momento del login (TOTP incluido). Nunca se registran. */
  credentials: () => LoginCredentials;
  heartbeatMs: number;
  backoffMs?: number[];
  maxConsecutiveFails?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Reconciliación de chats tras recuperar la sesión (sección 6.1, paso 7; F7). */
  onRecovered?: () => Promise<void>;
}

/**
 * Sesión del usuario robot en Abaya (sección 6.1):
 * storageState cifrado → login si hace falta → heartbeat → relogin con espera progresiva →
 * DOWN tras 3 fallos seguidos, con alerta crítica y sin insistir.
 */
export class SessionManager {
  private record: SessionRecord;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private readonly backoff: number[];
  private readonly maxFails: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly d: SessionManagerDeps) {
    this.backoff = d.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxFails = d.maxConsecutiveFails ?? MAX_CONSECUTIVE_FAILS;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? (() => new Date());
    this.record = {
      robotUser: d.robotUser,
      status: 'RELOGGING',
      lastHeartbeat: this.now(),
      lastLoginAt: null,
      consecutiveFails: 0,
    };
  }

  get status(): SessionStatus {
    return this.record.status;
  }

  get snapshot(): Readonly<SessionRecord> {
    return { ...this.record };
  }

  async start(): Promise<SessionStatus> {
    this.stopped = false;
    const prev = await this.d.repo.get(this.d.robotUser);
    if (prev?.status === 'DOWN') {
      // No insistir tras un DOWN: evita bloquear el usuario robot. Requiere reset manual.
      this.record = prev;
      this.d.gate.pause(GATE_REASON);
      await this.d.alerts.raise('SESSION_DOWN', 'CRITICA', {
        robotUser: this.d.robotUser,
        reason: 'arranque con sesión en DOWN; requiere reset manual',
      });
      return this.record.status;
    }
    if (prev) this.record = { ...prev, status: 'RELOGGING' };

    this.d.gate.pause(GATE_REASON);
    await this.persist();

    const state = await this.d.store.load();
    await this.d.driver.open(state);
    if (state && (await this.d.driver.isInboxVisible())) {
      this.d.logger.info({ robotUser: this.d.robotUser }, 'sesión restaurada desde storageState');
      await this.markActive(false);
    } else {
      await this.relogin('startup');
    }
    if (this.record.status === 'ACTIVE') this.scheduleHeartbeat();
    return this.record.status;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.d.driver.close();
  }

  /** Reset manual tras un DOWN (desde el panel en F7). */
  async resetDown(): Promise<void> {
    this.record = { ...this.record, status: 'RELOGGING', consecutiveFails: 0 };
    await this.persist();
  }

  /** Un ciclo de heartbeat. Público para pruebas; en producción lo llama el temporizador. */
  async heartbeat(): Promise<void> {
    if (this.busy || this.stopped || this.record.status !== 'ACTIVE') return;
    this.busy = true;
    try {
      if (await this.d.driver.isInboxVisible().catch(() => false)) {
        this.record.lastHeartbeat = this.now();
        await this.persist();
        return;
      }
      this.d.logger.warn({ robotUser: this.d.robotUser }, 'sesión perdida; iniciando relogin');
      await this.relogin('lost');
      if (this.record.status === 'ACTIVE') await this.d.onRecovered?.();
    } finally {
      this.busy = false;
    }
  }

  private scheduleHeartbeat() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.heartbeat().catch((err: unknown) =>
        this.d.logger.error({ err: errName(err) }, 'error en heartbeat'),
      );
    }, this.d.heartbeatMs);
    this.timer.unref?.();
  }

  private async relogin(reason: 'startup' | 'lost'): Promise<void> {
    this.d.gate.pause(GATE_REASON);
    this.record.status = 'RELOGGING';
    await this.persist();

    while (!this.stopped) {
      // Al arrancar, el primer intento va sin espera; tras una caída, también el primero espera.
      const waitIdx = this.record.consecutiveFails - (reason === 'startup' ? 1 : 0);
      if (waitIdx >= 0) {
        await this.sleep(this.backoff[Math.min(waitIdx, this.backoff.length - 1)]!);
        if (this.stopped) return;
      }

      const result = await this.tryLogin();
      if (result === 'OK') {
        await this.markActive(true);
        return;
      }

      this.record.consecutiveFails += 1;
      this.d.logger.warn(
        { robotUser: this.d.robotUser, result, consecutiveFails: this.record.consecutiveFails },
        'login fallido',
      );
      if (this.record.consecutiveFails >= this.maxFails) {
        await this.markDown(result);
        return;
      }
      await this.persist();
    }
  }

  private async tryLogin(): Promise<LoginResult | 'ERROR'> {
    try {
      await this.d.driver.open(undefined);
      if (await this.d.driver.isInboxVisible()) return 'OK';
      return await this.d.driver.login(this.d.credentials());
    } catch (err) {
      this.d.logger.error({ err: errName(err) }, 'error durante el login');
      return 'ERROR';
    }
  }

  private async markActive(freshLogin: boolean) {
    const now = this.now();
    this.record = {
      ...this.record,
      status: 'ACTIVE',
      consecutiveFails: 0,
      lastHeartbeat: now,
      lastLoginAt: freshLogin ? now : this.record.lastLoginAt,
    };
    if (freshLogin) await this.d.store.save(await this.d.driver.exportState());
    await this.persist();
    this.d.gate.resume(GATE_REASON);
    this.d.logger.info({ robotUser: this.d.robotUser, freshLogin }, 'sesión activa');
  }

  private async markDown(lastResult: string) {
    this.record.status = 'DOWN';
    await this.persist();
    clearInterval(this.timer);
    this.timer = undefined;
    await this.d.store.clear();
    await this.d.alerts.raise('SESSION_DOWN', 'CRITICA', {
      robotUser: this.d.robotUser,
      consecutiveFails: this.record.consecutiveFails,
      lastResult,
    });
  }

  private persist() {
    return this.d.repo.save({ ...this.record });
  }
}

/** Solo el tipo de error: los mensajes pueden traer datos de la página. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
