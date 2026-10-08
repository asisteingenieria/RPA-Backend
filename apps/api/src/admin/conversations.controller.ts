import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard, Roles, type AdminRequest } from './admin-auth.guard.js';
import { toHttp } from './http-errors.js';
import { ConversationsService, parseFilters } from './conversations.service.js';

type QueryParams = Record<string, unknown>;
interface DownloadResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Trazabilidad (D-002): conversaciones reales completas, sin enmascarar. Solo ADMIN (lo ve todo;
 * OPERADOR → 403). Cada apertura del detalle (CONVERSATION_VIEWED) y cada exportación
 * (CONVERSATIONS_EXPORTED) queda en Auditoría.
 */
@Controller('admin/conversations')
@UseGuards(AdminAuthGuard)
@Roles(['ADMIN'])
export class ConversationsController {
  constructor(@Inject(ConversationsService) private readonly conversations: ConversationsService) {}

  @Get()
  list(@Query() q: QueryParams) {
    return toHttp(Promise.resolve().then(() => this.conversations.list(parseFilters(q))));
  }

  @Get('stats')
  stats(@Query() q: QueryParams) {
    return toHttp(Promise.resolve().then(() => this.conversations.stats(parseFilters(q))));
  }

  /** CSV del filtro (sin texto de mensajes) o, con `?id=`, la transcripción de una conversación. */
  @Get('export')
  async export(
    @Query() q: QueryParams,
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: DownloadResponse,
  ) {
    const id = typeof q.id === 'string' ? q.id : undefined;
    if (id) {
      const t = await toHttp(this.conversations.transcript(id, req.adminUser));
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${t.name.replace(/[^\w.-]/g, '_')}"`,
      );
      return new StreamableFile(Buffer.from(t.text, 'utf8'));
    }
    const csv = await toHttp(
      Promise.resolve().then(() => this.conversations.exportCsv(parseFilters(q), req.adminUser)),
    );
    const day = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trazabilidad-${day}.csv"`);
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }

  /** Detalle completo. Con los filtros de la lista (`range`, …) devuelve también `nav`. */
  @Get(':id')
  async detail(@Param('id') id: string, @Query() q: QueryParams, @Req() req: AdminRequest) {
    let filters;
    if (q.range !== undefined) {
      try {
        filters = parseFilters(q);
      } catch {
        filters = undefined; // filtro inválido: se muestra el detalle sin anterior/siguiente
      }
    }
    return toHttp(this.conversations.detail(id, req.adminUser, filters));
  }
}
