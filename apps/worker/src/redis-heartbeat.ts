import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { loadConfig } from '@abaya/config';
import { createLogger } from '@abaya/logger';

const INTERVAL_MS = 30_000;

/** Mantiene vivo el proceso y verifica la conexión con Redis hasta que existan las colas (F3+). */
@Injectable()
export class RedisHeartbeat implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('worker.heartbeat');
  private redis?: Redis;
  private timer?: NodeJS.Timeout;

  async onModuleInit() {
    this.redis = new Redis(loadConfig().REDIS_URL, { maxRetriesPerRequest: null });
    await this.ping();
    this.timer = setInterval(() => void this.ping(), INTERVAL_MS);
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.redis?.quit();
  }

  private async ping() {
    try {
      await this.redis?.ping();
      this.logger.debug('redis ok');
    } catch (err) {
      this.logger.error({ err }, 'redis no responde');
    }
  }
}
