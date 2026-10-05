import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { RpaRuntimeService } from './rpa-runtime.service.js';

@Module({
  controllers: [HealthController],
  providers: [RpaRuntimeService],
})
export class AppModule {}
