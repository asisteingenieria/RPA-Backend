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
import { AdminAuthGuard, Roles, type AdminRequest } from './admin-auth.guard.js';
import { toHttp } from './http-errors.js';
import {
  KnowledgeService,
  type KnowledgeActor,
  type UploadedFileInput,
} from './knowledge.service.js';

/** Tope del multipart; el servicio aplica el límite exacto de cada uso. */
const UPLOAD_HARD_LIMIT = 50 * 1024 * 1024;

const actor = (req: AdminRequest): KnowledgeActor => ({
  username: req.adminUser,
  role: req.me.role,
  knowledgePublisher: req.me.knowledgePublisher,
});

/**
 * Brains (v1.9, docs/DECISIONS.md D-001). Ver y probar: ambos roles. Crear y cargar o quitar
 * fuentes: ADMIN. Publicar (con la suite), revertir y conectar a agentes: permiso
 * `publicarConocimiento` (ADMIN con la marca «Publicar conocimiento», se valida en el servicio).
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
  @Roles(['ADMIN'])
  create(@Body() body: unknown, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.create(req.adminUser, body));
  }

  @Get('brains/:id')
  get(@Param('id') id: string) {
    return toHttp(this.knowledge.get(id));
  }

  @Patch('brains/:id')
  @Roles(['ADMIN'])
  rename(@Param('id') id: string, @Body() body: unknown, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.rename(req.adminUser, id, body));
  }

  @Delete('brains/:id')
  @Roles(['ADMIN'])
  remove(@Param('id') id: string, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.remove(req.adminUser, id));
  }

  /** Multipart: `file` + `use` (CATALOG | FULL_CONTEXT | SEARCH) + `proceso` opcional. */
  @Post('brains/:id/sources')
  @Roles(['ADMIN'])
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_HARD_LIMIT, files: 1, fields: 5 },
      // Nombres de archivo con tildes llegan en UTF-8 desde el navegador.
      defParamCharset: 'utf8',
    }),
  )
  addSource(
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() body: unknown,
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.addFile(req.adminUser, id, file, body));
  }

  /** `{ name, text, use: FULL_CONTEXT | SEARCH, proceso? }` */
  @Post('brains/:id/sources/text')
  @Roles(['ADMIN'])
  addText(@Param('id') id: string, @Body() body: unknown, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.addText(req.adminUser, id, body));
  }

  /** `{ url, use: FULL_CONTEXT | SEARCH, refreshHours?, proceso? }` */
  @Post('brains/:id/sources/web')
  @Roles(['ADMIN'])
  addWeb(@Param('id') id: string, @Body() body: unknown, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.addWeb(req.adminUser, id, body));
  }

  @Delete('brains/:id/sources/:sourceId')
  @Roles(['ADMIN'])
  removeSource(
    @Param('id') id: string,
    @Param('sourceId') sourceId: string,
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.removeSource(req.adminUser, id, sourceId));
  }

  @Post('brains/:id/sources/:sourceId/reprocess')
  @Roles(['ADMIN'])
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

  /** Vista previa de una versión (`?process=PORTABILIDAD` filtra el catálogo). */
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
  @Roles(['ADMIN'])
  publish(@Param('id') id: string, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.publish(actor(req), id));
  }

  @Post('brains/:id/versions/:version/restore')
  @Roles(['ADMIN'])
  restore(@Param('id') id: string, @Param('version') version: string, @Req() req: AdminRequest) {
    return toHttp(this.knowledge.restore(actor(req), id, Number(version)));
  }

  /** `{ process }` → consultar_planes; `{ question, process? }` → documentos. `version: 'draft'` opcional. */
  @Post('brains/:id/test')
  test(@Param('id') id: string, @Body() body: unknown) {
    return toHttp(this.knowledge.test(id, body));
  }

  @Get('agents/:agentKey/brains')
  agentBrains(@Param('agentKey') agentKey: string) {
    return toHttp(this.knowledge.agentBrains(agentKey));
  }

  @Put('agents/:agentKey/brains/:brainId')
  @Roles(['ADMIN'])
  connect(
    @Param('agentKey') agentKey: string,
    @Param('brainId') brainId: string,
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.connect(actor(req), agentKey, brainId));
  }

  @Delete('agents/:agentKey/brains/:brainId')
  @Roles(['ADMIN'])
  disconnect(
    @Param('agentKey') agentKey: string,
    @Param('brainId') brainId: string,
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.knowledge.disconnect(actor(req), agentKey, brainId));
  }
}
