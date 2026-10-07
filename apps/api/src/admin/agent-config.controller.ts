import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard, Roles, type AdminRequest } from './admin-auth.guard.js';
import { AgentConfigService, AgentReviewError } from './agent-config.service.js';
import { toHttp } from './http-errors.js';

/** Revisión fallida → 400 con la lista de problemas para resaltarlos en el editor. */
async function withReview<T>(p: Promise<T>): Promise<T> {
  try {
    return await toHttp(p);
  } catch (err) {
    if (err instanceof AgentReviewError) {
      throw new BadRequestException({ message: err.message, issues: err.issues });
    }
    throw err;
  }
}

/**
 * Configuración del agente (v1.8, sección 6.3.8). Ver: ambos roles. Guardar, publicar y
 * restaurar: solo ADMIN. Publicar = pasar la suite de evaluación (regla 13).
 */
@Controller('admin/agent')
@UseGuards(AdminAuthGuard)
export class AgentConfigController {
  constructor(@Inject(AgentConfigService) private readonly agent: AgentConfigService) {}

  @Get()
  overview() {
    return this.agent.overview();
  }

  @Get('versions')
  versions(): Promise<unknown> {
    return this.agent.versions();
  }

  @Get('versions/:id')
  version(@Param('id') id: string) {
    return toHttp(this.agent.version(id));
  }

  @Post('review')
  review(@Body() body: unknown) {
    return toHttp(Promise.resolve().then(() => ({ issues: this.agent.review(body) })));
  }

  /** "Probar agente": un turno simulado del motor real (no toca Abaya ni guarda nada). */
  @Post('test')
  test(@Body() body: unknown, @Req() req: AdminRequest) {
    return withReview(this.agent.test(req.me.role, body));
  }

  @Put('draft')
  @Roles(['ADMIN'])
  saveDraft(@Body() body: unknown, @Req() req: AdminRequest) {
    return withReview(this.agent.saveDraft(req.adminUser, body));
  }

  @Post('draft/publish')
  @Roles(['ADMIN'])
  publish(@Req() req: AdminRequest) {
    return withReview(this.agent.publish(req.adminUser));
  }

  @Post('versions/:id/restore')
  @Roles(['ADMIN'])
  restore(@Param('id') id: string, @Req() req: AdminRequest) {
    return withReview(this.agent.restore(req.adminUser, id));
  }
}
