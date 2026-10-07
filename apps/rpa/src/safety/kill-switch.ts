import { KILL_SWITCH_KEY, robotPauseKey } from '@abaya/domain';
import { Redis } from 'ioredis';

/** Apagado de emergencia: revisado antes de cada acción de interfaz (regla 5). */
export interface KillSwitch {
  isActive(): Promise<boolean>;
}

/**
 * Banderas en Redis, activables en caliente desde el panel: el kill switch global (F7) y la
 * pausa de este robot (v1.4). Si Redis no responde se asume ACTIVO: ante la duda, no actúa.
 */
export class RedisKillSwitch implements KillSwitch {
  private readonly keys: string[];

  constructor(
    private readonly redis: Pick<Redis, 'mget' | 'set' | 'quit'>,
    robotUser?: string,
  ) {
    this.keys = [KILL_SWITCH_KEY, ...(robotUser ? [robotPauseKey(robotUser)] : [])];
  }

  static fromUrl(url: string, robotUser?: string) {
    return new RedisKillSwitch(
      new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false }),
      robotUser,
    );
  }

  async isActive(): Promise<boolean> {
    try {
      return (await this.redis.mget(...this.keys)).some((v) => v === '1');
    } catch {
      return true;
    }
  }

  async set(active: boolean) {
    await this.redis.set(KILL_SWITCH_KEY, active ? '1' : '0');
  }

  async close() {
    await this.redis.quit();
  }
}

export class MemoryKillSwitch implements KillSwitch {
  active = false;
  async isActive() {
    return this.active;
  }
}
