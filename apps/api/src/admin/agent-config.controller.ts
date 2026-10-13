import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminAuthGuard, Roles, type AdminRequest } from './admin-auth.guard.js';
import { AgentConfigService, AgentReviewError } from './agent-config.service.js';
import { toHttp } from './http-errors.js';
import { readBody, type RawRequest } from '../raw-body.js';
import { MAX_TEST_AUDIO_BYTES } from './agent-config.service.js';

/** Revisión fallida → 400 con la lista de problemas para resaltarlos en el editor. */
/** Guion (30 000 caracteres) + 80 plantillas + flujo: holgado. */
const AGENT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

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
 * Configuración del agente (v1.8, sección 6.3.8; D-004). Ver: ambos roles. Guardar, evaluar,
 * publicar, restaurar y guardar pruebas: solo ADMIN. Guardar puede lanzar la suite de evaluación
 * (regla 13); publicar usa el resultado ya calculado.
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
    return withReview(this.agent.test(req.me.role, body, req.adminUser));
  }

  /**
   * D-010: nota de voz de prueba. El audio va en el cuerpo (binario, sin subir el límite global
   * de JSON) y devuelve un `audioId` de un solo uso para `POST test`.
   */
  @Post('test/audio')
  @HttpCode(200)
  async testAudio(@Query() query: unknown, @Req() req: AdminRequest & RawRequest) {
    const audio = await readBody(req, MAX_TEST_AUDIO_BYTES, 'Nota de voz demasiado grande');
    const type = req.headers['content-type'];
    return toHttp(
      Promise.resolve().then(() =>
        this.agent.uploadTestAudio(
          req.adminUser,
          Array.isArray(type) ? type[0] : type,
          query,
          audio,
        ),
      ),
    );
  }

  @Put('draft')
  @Roles(['ADMIN'])
  saveDraft(@Body() body: unknown, @Req() req: AdminRequest) {
    return withReview(this.agent.saveDraft(req.adminUser, body));
  }

  /** Publica al instante una versión ya evaluada (D-004): OK, o WARN con motivo; nunca BLOCKED. */
  @Post('draft/publish')
  @Roles(['ADMIN'])
  publish(@Body() body: unknown, @Req() req: AdminRequest) {
    return withReview(this.agent.publish(req.adminUser, body));
  }

  /** Corre la suite sobre una versión guardada; el resultado queda en la versión (D-004). */
  @Post('versions/:id/evaluate')
  @Roles(['ADMIN'])
  evaluate(@Param('id') id: string, @Req() req: AdminRequest) {
    return withReview(this.agent.evaluate(req.adminUser, id));
  }

  /** Pruebas de "Probar agente" guardadas en el historial de una versión (D-004). */
  @Get('versions/:id/tests')
  tests(@Param('id') id: string): Promise<unknown> {
    return this.agent.tests(id);
  }

  /** Todas las pruebas guardadas, las más recientes primero (con su versión o sin versión). */
  @Get('tests/recent')
  recentTests(): Promise<unknown> {
    return this.agent.recentTests();
  }

  /** Pruebas guardadas sin versión: se probó el editor con cambios sin guardar. */
  @Get('tests/unversioned')
  unversionedTests(): Promise<unknown> {
    return this.agent.unversionedTests();
  }

  @Post('tests')
  @Roles(['ADMIN'])
  saveTest(@Body() body: unknown, @Req() req: AdminRequest) {
    return toHttp(this.agent.saveTest(req.adminUser, body));
  }

  @Post('versions/:id/restore')
  @Roles(['ADMIN'])
  restore(@Param('id') id: string, @Req() req: AdminRequest) {
    return withReview(this.agent.restore(req.adminUser, id));
  }

  /** D-019: una versión como archivo JSON («abaya-agente») para llevarla a otro ambiente. */
  @Get('versions/:id/export')
  @Roles(['ADMIN'])
  exportVersion(@Param('id') id: string, @Req() req: AdminRequest) {
    return toHttp(this.agent.exportVersion(req.adminUser, id));
  }

  /** D-019: importa un archivo exportado como borrador (multipart, campo `file`). */
  @Post('import')
  @Roles(['ADMIN'])
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: AGENT_IMPORT_MAX_BYTES, files: 1 } }),
  )
  importVersion(@UploadedFile() file: { buffer?: Buffer } | undefined, @Req() req: AdminRequest) {
    return withReview(this.agent.importVersion(req.adminUser, file));
  }
}

