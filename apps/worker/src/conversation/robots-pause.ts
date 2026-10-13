import { KILL_SWITCH_KEY, KILL_SWITCH_REASON_KEY } from '@abaya/domain';
import { Redis } from 'ioredis';

/**
 * D-009: el worker respeta el apagado de emergencia (pausados no se llama al modelo) y lo
 * activa solo cuando el proveedor de LLM no responde. Es la misma bandera del panel: reanudar
 * sigue siendo solo de un ADMIN.
 */
export interface RobotsPause {
  isPaused(): Promise<boolean>;
  /** Pausa todos los robots con un motivo visible en el panel. No pisa una pausa manual. */
  pauseAll(cause: string, detail: string): Promise<void>;
}

export class RedisRobotsPause implements RobotsPause {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
  }

  async isPaused(): Promise<boolean> {
    try {
      return (await this.redis.get(KILL_SWITCH_KEY)) === '1';
    } catch {
      // Sin Redis tampoco hay colas: el turno no podría completarse. Ante la duda, esperar.
      return true;
    }
  }

  async pauseAll(cause: string, detail: string): Promise<void> {
    const reason = JSON.stringify({ cause, detail, at: new Date().toISOString() });
    // Solo si no estaba pausado: un apagado manual conserva su (falta de) motivo.
    const set = await this.redis.set(KILL_SWITCH_KEY, '1', 'GET');
    if (set !== '1') await this.redis.set(KILL_SWITCH_REASON_KEY, reason);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export class MemoryRobotsPause implements RobotsPause {
  paused = false;
  reason: { cause: string; detail: string } | null = null;

  async isPaused() {
    return this.paused;
  }

  async pauseAll(cause: string, detail: string) {
    if (!this.paused) this.reason = { cause, detail };
    this.paused = true;
  }
}
