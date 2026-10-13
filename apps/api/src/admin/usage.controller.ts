import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { toHttp } from './http-errors.js';
import { UsageService } from './usage.service.js';

/**
 * Vista «Consumo»: tokens y costo estimado de los modelos. Solo cifras (sin contenido de
 * mensajes ni datos personales): la ven ambos roles. `?range=hoy|7d|30d|custom&from&to`.
 */
@Controller('admin/usage')
@UseGuards(AdminAuthGuard)
export class UsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}

  @Get()
  summary(@Query() q: Record<string, unknown>) {
    return toHttp(Promise.resolve().then(() => this.usage.summary(q)));
  }
}
