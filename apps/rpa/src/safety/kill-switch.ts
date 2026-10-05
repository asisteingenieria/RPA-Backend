import { Redis } from 'ioredis';

export const KILL_SWITCH_KEY = 'abaya:killswitch';

/** Apagado de emergencia: revisado antes de cada acción de interfaz (regla 5). */
export interface KillSwitch {
  isActive(): Promise<boolean>;
}

/**
 * Bandera en Redis, activable en caliente desde el panel (F7). Si Redis no responde se
 * asume ACTIVO: ante la duda, el robot no actúa.
 */
export class RedisKillSwitch implements KillSwitch {
  constructor(private readonly redis: Redis) {}

  static fromUrl(url: string) {
    return new RedisKillSwitch(new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false }));
  }

  async isActive(): Promise<boolean> {
    try {
      return (await this.redis.get(KILL_SWITCH_KEY)) === '1';
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
