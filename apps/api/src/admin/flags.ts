import { Redis } from 'ioredis';

/** Banderas de operación compartidas con el rpa (p. ej. el kill switch). */
export interface FlagStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}

export class RedisFlagStore implements FlagStore {
  private readonly redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
  }
  get(key: string) {
    return this.redis.get(key);
  }
  async set(key: string, value: string) {
    await this.redis.set(key, value);
  }
  async close() {
    await this.redis.quit();
  }
}

export class MemoryFlagStore implements FlagStore {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async close() {}
}
