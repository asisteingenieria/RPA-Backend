import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SCREEN_WATCH_TTL_S, type LiveBus } from '@abaya/robot-store';
import { AdminAuthGuard, Roles, type AdminRequest } from './admin-auth.guard.js';
import { LiveService } from './live.service.js';
import { UsersService } from './users.service.js';

export const LIVE_BUS = Symbol('LIVE_BUS');

/** Comentario SSE para que nginx y el navegador no den la conexión por muerta. */
const PING_MS = 15_000;
/** Cada cuánto se revisa que la sesión del ADMIN siga valiendo (un stream dura horas). */
const RECHECK_MS = 60_000;
const CHAT_EVERY_MS = 1_000;
/** Si el navegador no alcanza a recibir, se saltan imágenes en vez de acumularlas. */
const MAX_BUFFERED = 2 * 1024 * 1024;

type LiveRequest = AdminRequest & IncomingMessage;

/** Un stream de eventos del servidor (SSE) sobre la respuesta HTTP. */
class SseStream {
  closed = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly onClose: (() => void)[] = [];

  constructor(private readonly res: ServerResponse) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx: entregar cada evento apenas sale (sin búfer).
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.on('close', () => this.close());
    this.every(PING_MS, () => void this.res.write(': ping\n\n'));
  }

  /** false si no se envió (cerrado o con el búfer lleno). */
  send(event: string, data: unknown, droppable = false): boolean {
    if (this.closed) return false;
    if (droppable && this.res.writableLength > MAX_BUFFERED) return false;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  every(ms: number, fn: () => void) {
    this.timers.push(setInterval(fn, ms));
  }

  /** Al cerrar (o ya, si el navegador se fue antes de que se registrara). */
  finally(fn: () => void) {
    if (this.closed) fn();
    else this.onClose.push(fn);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.timers.forEach(clearInterval);
    for (const fn of this.onClose) fn();
    this.res.end();
  }
}

/**
 * Monitor en vivo (D-032), solo ADMIN: el tablero de los robots con sus chats, los mensajes de un
 * chat y la pantalla de un robot, empujados por SSE. Solo mirar: nada de aquí toca Abaya.
 * Abrir el tablero (LIVE_VIEWED), un chat (CONVERSATION_VIEWED) y la pantalla (SCREEN_VIEWED /
 * SCREEN_VIEW_ENDED con los segundos) queda en Auditoría.
 */
@Controller('admin/live')
@UseGuards(AdminAuthGuard)
@Roles(['ADMIN'])
export class LiveController {
  constructor(
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(LIVE_BUS) private readonly bus: LiveBus,
  ) {}

  /** Tablero (`board`) y, con `?chat=`, los mensajes de ese chat (`chat`) cuando cambian. */
  @Get('stream')
  async stream(
    @Query('chat') chatRef: string | undefined,
    @Req() req: LiveRequest,
    @Res() res: ServerResponse,
  ) {
    const actor = req.adminUser;
    let chat: Awaited<ReturnType<LiveService['chat']>> = null;
    if (typeof chatRef === 'string' && chatRef) {
      chat = await this.live.chat(chatRef);
      if (!chat) throw new NotFoundException('Conversación no encontrada');
    }
    await this.live.auditBoardView(actor);
    if (chat) await this.live.auditChatView(actor, chat);

    const sse = new SseStream(res);
    this.watchSession(sse, req);
    sse.finally(this.live.subscribeBoard((b) => sse.send('board', b)));

    if (chat) {
      const id = chat.id;
      let last = JSON.stringify(chat);
      sse.send('chat', chat);
      let busy = false;
      sse.every(CHAT_EVERY_MS, () => {
        if (busy) return;
        busy = true;
        void this.live
          .chat(id)
          .then((c) => {
            const json = JSON.stringify(c);
            if (c && json !== last) {
              last = json;
              sse.send('chat', c);
            }
          })
          .catch(() => undefined)
          .finally(() => (busy = false));
      });
    }
  }

  /**
   * Pantalla del robot: mientras esta conexión esté abierta el robot transmite (marca en Redis
   * que se renueva); al cerrarla, deja de transmitir solo cuando nadie más mira.
   */
  @Get('robots/:robotUser/screen')
  async screen(
    @Param('robotUser') robotUser: string,
    @Req() req: LiveRequest,
    @Res() res: ServerResponse,
  ) {
    if (!(await this.live.robotExists(robotUser))) {
      throw new NotFoundException('Robot no encontrado');
    }
    const actor = req.adminUser;
    await this.live.auditScreen(actor, robotUser);
    const started = Date.now();
    await this.bus.watchScreen(robotUser);

    const sse = new SseStream(res);
    this.watchSession(sse, req);
    sse.every((SCREEN_WATCH_TTL_S * 1_000) / 2.5, () => {
      void this.bus.watchScreen(robotUser).catch(() => undefined);
    });
    const last = await this.bus.lastFrame(robotUser).catch(() => null);
    if (last) sse.send('frame', last, true);
    const unsubscribe = await this.bus.subscribeFrames(robotUser, (f) =>
      sse.send('frame', f, true),
    );
    sse.finally(() => {
      void unsubscribe();
      const seconds = Math.round((Date.now() - started) / 1_000);
      void this.live.auditScreen(actor, robotUser, seconds).catch(() => undefined);
    });
  }

  private watchSession(sse: SseStream, req: LiveRequest) {
    sse.every(RECHECK_MS, () => {
      void this.users
        .sessionStillValid(req.me.sessionId, 'ADMIN')
        .then((ok) => {
          if (!ok) {
            sse.send('end', { reason: 'SESSION' });
            sse.close();
          }
        })
        .catch(() => undefined);
    });
  }
}
