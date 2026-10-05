import { Controller, Get, Inject } from '@nestjs/common';
import { SessionService } from '../session/session.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(SessionService) private readonly session: Pick<SessionService, 'status'>) {}

  @Get()
  health() {
    return {
      status: 'ok',
      service: 'rpa',
      uptimeSec: Math.round(process.uptime()),
      session: this.session.status,
    };
  }
}
