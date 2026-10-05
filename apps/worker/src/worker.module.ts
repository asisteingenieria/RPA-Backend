import { Module } from '@nestjs/common';
import { RedisHeartbeat } from './redis-heartbeat.js';

// Motor de conversación, ventas y outbox se agregan en F5–F6.
@Module({
  providers: [RedisHeartbeat],
})
export class WorkerModule {}
