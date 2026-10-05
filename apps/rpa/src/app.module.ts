import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { SessionService } from './session/session.service.js';

@Module({
  controllers: [HealthController],
  providers: [SessionService],
})
export class AppModule {}
