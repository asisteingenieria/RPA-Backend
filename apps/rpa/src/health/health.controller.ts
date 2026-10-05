import { Controller, Get, Inject } from '@nestjs/common';
import { RpaRuntimeService } from '../rpa-runtime.service.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(RpaRuntimeService) private readonly session: Pick<RpaRuntimeService, 'status'>,
  ) {}

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
