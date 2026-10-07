import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { KNOWLEDGE_LIMITS } from '@abaya/knowledge';
import { AdminAuthGuard, Roles, type AdminRequest } from './admin-auth.guard.js';
import { toHttp } from './http-errors.js';
import { KnowledgeService, type UploadedFileInput } from './knowledge.service.js';

/** Escribir en los Brains es el permiso `publicarConocimiento`: hoy, solo ADMIN. */
const PUBLICAR_CONOCIMIENTO = ['ADMIN'] as const;

/**
 * Brains (v1.9, docs/DECISIONS.md D-001). Ver y probar: ambos roles. Crear, cargar o quitar
 * fuentes, publicar (con la suite), revertir y conectar a agentes: `publicarConocimiento`.
 */
@Controller('admin/knowledge')
@UseGuards(AdminAuthGuard)
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  @Get('brains')
  list() {
    return toHttp(this.knowledge.list());
  }

  @Post('brains')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  create(@Body() body: unknown, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.create(req.adminUser, body));
  }

  @Get('brains/:id')
  get(@Param('id') id: string) {
    return toHttp(this.knowledge.get(id));
  }

  @Patch('brains/:id')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  rename(@Param('id') id: string, @Body() body: unknown, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.rename(req.adminUser, id, body));
  }

  @Delete('brains/:id')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  remove(@Param('id') id: string, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.remove(req.adminUser, id));
  }

  /** Multipart: campo `file` (Excel o CSV) y `use` (hoy solo CATALOG). */
  @Post('brains/:id/sources')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: KNOWLEDGE_LIMITS.catalogMaxBytes, files: 1, fields: 5 },
      // Nombres de archivo con tildes llegan en UTF-8 desde el navegador.
      defParamCharset: 'utf8',
    }),
  )
  addSource(
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() body: { use?: unknown },
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.addFile(req.adminUser, id, file, body?.use));
  }

  @Delete('brains/:id/sources/:sourceId')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  removeSource(
    @Param('id') id: string,
    @Param('sourceId') sourceId: string,
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.removeSource(req.adminUser, id, sourceId));
  }

  @Post('brains/:id/sources/:sourceId/reprocess')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  reprocess(
    @Param('id') id: string,
    @Param('sourceId') sourceId: string,
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.reprocess(req.adminUser, id, sourceId));
  }

  @Get('brains/:id/versions')
  versions(@Param('id') id: string) {
    return toHttp(this.knowledge.versions(id));
  }

  /** Vista previa del catálogo de una versión (`?process=PORTABILIDAD`). */
  @Get('brains/:id/versions/:version')
  version(
    @Param('id') id: string,
    @Param('version') version: string,
    @Query('process') process?: string,
  ) {
    return toHttp(this.knowledge.version(id, Number(version), process));
  }

  /** Diferencias contra la publicada o contra otra versión (`?against=3`). */
  @Get('brains/:id/versions/:version/diff')
  diff(
    @Param('id') id: string,
    @Param('version') version: string,
    @Query('against') against?: string,
  ) {
    return toHttp(this.knowledge.diff(id, Number(version), against));
  }

  @Post('brains/:id/draft/publish')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  publish(@Param('id') id: string, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.publish(req.adminUser, id));
  }

  @Post('brains/:id/versions/:version/restore')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  restore(@Param('id') id: string, @Param('version') version: string, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.restore(req.adminUser, id, Number(version)));
  }

  /** Lo que devolvería `consultar_planes(proceso)`: `{ process, version?: 'draft' }`. */
  @Post('brains/:id/test')
  test(@Param('id') id: string, @Body() body: unknown) {
    return toHttp(this.knowledge.test(id, body));
  }

  @Get('agents/:agentKey/brains')
  agentBrains(@Param('agentKey') agentKey: string) {
    return toHttp(this.knowledge.agentBrains(agentKey));
  }

  @Put('agents/:agentKey/brains/:brainId')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  connect(
    @Param('agentKey') agentKey: string,
    @Param('brainId') brainId: string,
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.connect(req.adminUser, agentKey, brainId));
  }

  @Delete('agents/:agentKey/brains/:brainId')
  @Roles([...PUBLICAR_CONOCIMIENTO])
  disconnect(
    @Param('agentKey') agentKey: string,
    @Param('brainId') brainId: string,
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.disconnect(req.adminUser, agentKey, brainId));
  }
}
