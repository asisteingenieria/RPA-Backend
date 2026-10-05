import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'rpa', uptimeSec: Math.round(process.uptime()) };
  }
}
