import type { AlertPort, RpaAction, RpaActionResult } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import type { Page } from 'playwright';
import { ChatListPage } from '../abaya/pages/chat-list.page.js';
import { ChatPage } from '../abaya/pages/chat.page.js';
import { FinishPage } from '../abaya/pages/finish.page.js';
import type { ActionLog } from '../audit/action-log.js';
import type {
  OutboundImage,
  OutboundMessage,
  OutboundRepository,
} from '../outbound/outbound.repository.js';
import type { ChatIdentityGuard } from '../safety/chat-identity-guard.js';
import type { KillSwitch } from '../safety/kill-switch.js';
import type { ActorGate } from './actor-gate.js';
import { NoopTraceRecorder, type TraceRecorder } from '../observability/trace-recorder.js';
import { PRIORITY, SerialExecutor, type Priority } from './serial-executor.js';

export type SendOutcome =
  | 'SENT_VERIFIED'
  | 'ALREADY_SENT'
  | 'UNCERTAIN'
  | 'BLOCKED_KILL_SWITCH'
  | 'SKIPPED_UNCERTAIN'
  | 'NOT_FOUND'
  /** D-014 fase 2: la imagen del mensaje ya no existe (nada se envió). */
  | 'FAILED';

/** Resultado de transferir o cerrar. UNCERTAIN nunca se reintenta a ciegas (regla 2). */
export type HandoffOutcome =
  | { result: 'OK' }
  | { result: 'BLOCKED_KILL_SWITCH' }
  | { result: 'FAILED'; reason: string }
  | { result: 'UNCERTAIN'; reason: string };

export interface TransferRequest {
  abayaChatId: string;
  /**
   * BACKOFFICE: venta autorizada → «Finalizar» sin cerrar el caso (ySocial lo pasa a la cola
   * de backoffice; confirmado por el responsable el 09/10/2026).
   * HUMAN: escalar a un asesor humano. ❓ No se ha visto cómo se hace en ySocial: no se toca
   * Abaya y se pide revisión humana con alerta.
   */
  target: 'BACKOFFICE' | 'HUMAN';
}

export interface CloseRequest {
  abayaChatId: string;
  /** Etiqueta de cierre («Finalizar y cerrar el caso»). */
  tag: string;
}

export class ActionBlockedError extends Error {
  override name = 'ActionBlockedError';
}

export interface BrowserActorDeps {
  robotUser: string;
  page: () => Page;
  gate: ActorGate;
  killSwitch: KillSwitch;
  guard: ChatIdentityGuard;
  actionLog: ActionLog;
  outbound: OutboundRepository;
  alerts: AlertPort;
  logger: Logger;
  verifyTimeoutMs?: number;
  /** Cuántos mensajes recientes del robot revisar para idempotencia (sección 6.4, paso 4). */
  idempotencyWindow?: number;
  now?: () => Date;
  /** Trazas solo en error (sección 8). */
  tracer?: TraceRecorder;
}

/**
 * ÚNICA puerta de acciones sobre la interfaz de Abaya (regla 4, sección 2.4).
 * Una acción a la vez; antes de cada una revisa la compuerta de sesión y el KillSwitch
 * (regla 5); verifica la identidad del chat (regla 1); nunca reintenta a ciegas un envío
 * incierto (regla 2); registra todo en RpaActionLog (regla 9).
 */
export class BrowserActor {
  private readonly exec = new SerialExecutor();
  private readonly now: () => Date;
  private readonly tracer: TraceRecorder;

  constructor(private readonly d: BrowserActorDeps) {
    this.now = d.now ?? (() => new Date());
    this.tracer = d.tracer ?? new NoopTraceRecorder();
  }

  /** Ejecuta una acción serializada con su chunk de traza (se guarda solo si algo falla). */
  private traced<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
    return this.exec.run(async () => {
      await this.tracer.begin();
      try {
        return await fn();
      } finally {
        await this.tracer.discard();
      }
    }, priority);
  }

  get queued(): number {
    return this.exec.size;
  }

  /** Envía un mensaje saliente ya persistido (sección 6.4). */
  sendMessage(messageId: string): Promise<SendOutcome> {
    return this.traced(PRIORITY.SEND, () => this.doSend(messageId));
  }

  /** Lectura de la bandeja (sin clics), serializada con las acciones para no chocar con ellas. */
  readInboxChatIds(): Promise<string[]> {
    return this.exec.run(
      async () => (await new ChatListPage(this.d.page()).listChats()).map((c) => c.abayaChatId),
      PRIORITY.READ_INBOX,
    );
  }

  /**
   * Ejecuta `fn` como acción exclusiva de la fila, con la prioridad más baja, y solo si no hay
   * otras acciones esperando y la bandeja está vacía: nunca interrumpe un envío ni deja un chat
   * a medias. Lo usan el reciclaje del navegador (v1.5) y el cambio de versión (v1.7).
   */
  runIfIdle<T>(
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false; reason: 'BUSY' | 'CHATS' }> {
    return this.exec.run(async () => {
      if (this.exec.size > 1) return { ran: false as const, reason: 'BUSY' as const };
      const chats = await new ChatListPage(this.d.page()).listChats();
      if (chats.length) return { ran: false as const, reason: 'CHATS' as const };
      return { ran: true as const, value: await fn() };
    }, PRIORITY.MAINTENANCE);
  }

  /** Reciclaje del navegador (v1.5): solo con la fila y la bandeja vacías. */
  async recycleIfIdle(recycle: () => Promise<void>): Promise<'RECYCLED' | 'BUSY' | 'CHATS'> {
    const r = await this.runIfIdle(recycle);
    return r.ran ? 'RECYCLED' : r.reason;
  }

  /** Bandeja con los no leídos de cada chat (sin clics), para el barrido de perdidos. */
  readInbox(): Promise<{ abayaChatId: string; unread: number }[]> {
    return this.exec.run(
      async () =>
        (await new ChatListPage(this.d.page()).listChats()).map((c) => ({
          abayaChatId: c.abayaChatId,
          unread: c.unread,
        })),
      PRIORITY.READ_INBOX,
    );
  }

  /** Abre un chat (lo usa el worker para leer chats con no leídos, y las demás acciones). */
  openChat(abayaChatId: string): Promise<boolean> {
    return this.traced(PRIORITY.OPEN_CHAT, async () => {
      const start = Date.now();
      if (!(await this.preflight('OPEN_CHAT', abayaChatId, start))) return false;
      const ok = await this.open(abayaChatId);
      await this.log('OPEN_CHAT', abayaChatId, ok ? 'OK' : 'UNCERTAIN', start);
      return ok;
    });
  }

  /**
   * Sección 6.5 en ySocial: abrir el caso → verificar identidad → «Finalizar» (sin cerrar el
   * caso: pasa a la cola de backoffice) → verificar que salió de la bandeja.
   */
  transfer(req: TransferRequest): Promise<HandoffOutcome> {
    return this.traced(PRIORITY.TRANSFER, async () => {
      const start = Date.now();
      const chatId = req.abayaChatId;
      if (!(await this.preflight('TRANSFER', chatId, start)))
        return { result: 'BLOCKED_KILL_SWITCH' };
      if (req.target === 'HUMAN') {
        // ❓ Cómo se escala a un asesor humano en ySocial no se ha visto: no tocar Abaya.
        await this.log('TRANSFER', chatId, 'SKIPPED', start);
        return {
          result: 'UNCERTAIN',
          reason: 'escalar a un asesor humano no está definido en ySocial: atenderlo a mano',
        };
      }
      const page = this.d.page();
      const chat = new ChatPage(page);

      if (!(await this.open(chatId))) {
        // ¿Ya no está en la bandeja? Pudo finalizarse en un intento previo que murió.
        const stillAssigned = (await new ChatListPage(page).listChats()).some(
          (c) => c.abayaChatId === chatId,
        );
        await this.log('TRANSFER', chatId, stillAssigned ? 'ERROR' : 'UNCERTAIN', start);
        return stillAssigned
          ? { result: 'FAILED', reason: 'no se pudo abrir el caso' }
          : { result: 'UNCERTAIN', reason: 'el caso ya no está en la bandeja' };
      }
      if (!(await this.identityOk(chat, chatId, 'transfer'))) {
        await this.log('TRANSFER', chatId, 'UNCERTAIN', start);
        return { result: 'UNCERTAIN', reason: 'identidad del caso no verificada' };
      }

      try {
        await new FinishPage(page).finishKeepCase();
      } catch {
        // El menú o la confirmación pudo quedar a medias: no sabemos si se finalizó.
        await this.log('TRANSFER', chatId, 'UNCERTAIN', start);
        return { result: 'UNCERTAIN', reason: 'error al finalizar el caso' };
      }
      const gone = await this.waitChatGone(chatId);
      await this.log('TRANSFER', chatId, gone ? 'OK' : 'UNCERTAIN', start);
      return gone
        ? { result: 'OK' }
        : { result: 'UNCERTAIN', reason: 'el caso sigue en la bandeja tras finalizar' };
    });
  }

  /**
   * Sección 6.6 en ySocial: «Finalizar y cerrar el caso» con su etiqueta y verificar que salió
   * de la bandeja.
   */
  closeConversation(req: CloseRequest): Promise<HandoffOutcome> {
    const { abayaChatId } = req;
    return this.traced(PRIORITY.CLOSE, async () => {
      const start = Date.now();
      if (!(await this.preflight('CLOSE', abayaChatId, start)))
        return { result: 'BLOCKED_KILL_SWITCH' };
      const chat = new ChatPage(this.d.page());
      if (!(await this.open(abayaChatId)) || !(await this.identityOk(chat, abayaChatId, 'close'))) {
        await this.log('CLOSE', abayaChatId, 'UNCERTAIN', start);
        return { result: 'UNCERTAIN', reason: 'caso no verificado' };
      }
      try {
        await new FinishPage(this.d.page()).finishCloseCase(req.tag);
      } catch {
        await this.log('CLOSE', abayaChatId, 'UNCERTAIN', start);
        return { result: 'UNCERTAIN', reason: 'error al cerrar el caso' };
      }
      const gone = await this.waitChatGone(abayaChatId);
      await this.log('CLOSE', abayaChatId, gone ? 'OK' : 'UNCERTAIN', start);
      return gone
        ? { result: 'OK' }
        : { result: 'UNCERTAIN', reason: 'el caso sigue en la bandeja' };
    });
  }

  private async waitChatGone(chatId: string, timeoutMs = 10_000): Promise<boolean> {
    const list = new ChatListPage(this.d.page());
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chats = await list.listChats().catch(() => null);
      if (chats && !chats.some((c) => c.abayaChatId === chatId)) return true;
      await this.d.page().waitForTimeout(200);
    }
    return false;
  }

  private async doSend(messageId: string): Promise<SendOutcome> {
    const start = Date.now();
    const msg = await this.d.outbound.get(messageId);
    if (!msg) return 'NOT_FOUND';
    const chatId = msg.abayaChatId;

    if (msg.status === 'SENT_VERIFIED') return 'ALREADY_SENT';
    if (msg.status === 'UNCERTAIN') {
      // Regla 2: un UNCERTAIN nunca se reintenta solo; pasa a revisión humana.
      await this.log('SEND', chatId, 'SKIPPED', start);
      return 'SKIPPED_UNCERTAIN';
    }
    if (!(await this.preflight('SEND', chatId, start))) return 'BLOCKED_KILL_SWITCH';

    const { text } = msg;
    const chat = new ChatPage(this.d.page());

    // 2–3. Abrir el chat y verificar identidad.
    const opened = await this.open(chatId);
    if (!opened || !(await this.identityOk(chat, chatId, messageId))) {
      return this.uncertain(messageId, chatId, start, 'identidad del chat no verificada');
    }
    if (msg.image) return this.sendImage(msg, msg.image, chat, start);

    // 4. Idempotencia SOLO si un intento anterior pudo haber enviado ESTE mensaje (el proceso
    // murió en SENDING). Un mensaje PENDING nunca se intentó: aunque el robot haya dicho el
    // mismo texto antes (plantillas, respuestas cortas), es una respuesta nueva y se envía.
    if (msg.status === 'SENDING') {
      const recent = await chat.lastAgentTexts(this.d.idempotencyWindow ?? 3);
      if (recent.includes(text.trim())) {
        await this.d.outbound.setStatus(messageId, 'SENT_VERIFIED');
        await this.log('SEND', chatId, 'OK', start);
        return 'ALREADY_SENT';
      }
      // Murió durante un envío y el texto no aparece: puede haberse enviado a medias o
      // estar pendiente en la interfaz. No reintentar a ciegas.
      return this.uncertain(messageId, chatId, start, 'envío previo interrumpido');
    }

    // 5–6. Escribir y enviar. Antes del clic, el estado queda en SENDING.
    await this.d.outbound.setStatus(messageId, 'SENDING', true);
    try {
      await chat.typeMessage(text);
    } catch (err) {
      // Nada se envió todavía: vuelve a PENDING para que la cola lo reintente.
      await this.d.outbound.setStatus(messageId, 'PENDING');
      await this.log('SEND', chatId, 'ERROR', start);
      throw err;
    }
    // Revalidar identidad justo antes de enviar (algo pudo cambiar el chat activo).
    if (!(await this.identityOk(chat, chatId, messageId))) {
      return this.uncertain(messageId, chatId, start, 'el chat cambió antes de enviar');
    }
    // Cuántas veces está ya este texto confirmado: la verificación exige una más.
    const confirmedBefore = await chat.countConfirmedAgentMessages(text);
    try {
      await chat.clickSend();
    } catch {
      return this.uncertain(messageId, chatId, start, 'error al hacer clic en enviar');
    }

    // 6–7. Verificar que aparece.
    const seen = await chat.waitForAgentMessage(
      text,
      this.d.verifyTimeoutMs ?? 10_000,
      confirmedBefore,
    );
    if (!seen) return this.uncertain(messageId, chatId, start, 'mensaje no apareció tras enviar');

    await this.d.outbound.setStatus(messageId, 'SENT_VERIFIED');
    await this.log('SEND', chatId, 'OK', start);
    return 'SENT_VERIFIED';
  }

  /**
   * D-014 fase 2: imagen de planes con su pie de foto, como la asesora: escribir el texto, pegar
   * la imagen en la caja (ySocial la pone en la cola de adjuntos), enviar y verificar que el
   * caso muestra el mensaje con adjunto confirmado por el servidor.
   */
  private async sendImage(
    msg: OutboundMessage,
    image: OutboundImage,
    chat: ChatPage,
    start: number,
  ): Promise<SendOutcome> {
    const { id: messageId, abayaChatId: chatId, text } = msg;
    // Regla 2: un intento anterior murió a mitad: no se sabe si la imagen salió. Revisión humana.
    if (msg.status === 'SENDING') {
      return this.uncertain(messageId, chatId, start, 'envío de imagen interrumpido');
    }
    const bytes = await this.d.outbound.imageBytes(messageId);
    if (!bytes) {
      // La versión del Brain ya no tiene la imagen: nada se envió y no tiene sentido reintentar.
      await this.d.outbound.setStatus(messageId, 'FAILED');
      await this.log('SEND', chatId, 'ERROR', start);
      await this.d.alerts.raise('SEND_IMAGE_MISSING', 'ALTA', {
        messageId,
        abayaChatId: chatId,
        imageId: image.id,
      });
      return 'FAILED';
    }
    // Algo ya en la cola de adjuntos (de otra acción o a mano) se enviaría junto: no tocar.
    if ((await chat.queuedAttachments()) > 0) {
      return this.uncertain(messageId, chatId, start, 'la caja ya tenía adjuntos en cola');
    }

    await this.d.outbound.setStatus(messageId, 'SENDING', true);
    try {
      await chat.typeMessage(text);
      await chat.pasteImage(bytes, image.mime, image.fileName);
    } catch (err) {
      await this.d.outbound.setStatus(messageId, 'PENDING');
      await this.log('SEND', chatId, 'ERROR', start);
      throw err;
    }
    if (!(await chat.waitForQueuedAttachments(1))) {
      // La imagen no entró a la cola (o entró más de una): no enviar nada.
      return this.uncertain(messageId, chatId, start, 'la imagen no quedó adjunta en la caja');
    }
    if (!(await this.identityOk(chat, chatId, messageId))) {
      return this.uncertain(messageId, chatId, start, 'el chat cambió antes de enviar');
    }
    const confirmedBefore = await chat.countConfirmedAgentImages(text);
    try {
      await chat.clickSend();
    } catch {
      return this.uncertain(messageId, chatId, start, 'error al hacer clic en enviar');
    }
    const seen = await chat.waitForAgentImage(
      text,
      // Subir la imagen toma más que un texto.
      (this.d.verifyTimeoutMs ?? 10_000) * 2,
      confirmedBefore,
    );
    if (!seen) return this.uncertain(messageId, chatId, start, 'la imagen no apareció tras enviar');
    await this.d.outbound.setStatus(messageId, 'SENT_VERIFIED');
    await this.log('SEND', chatId, 'OK', start);
    return 'SENT_VERIFIED';
  }

  /** Revisa compuerta de sesión y KillSwitch (regla 5). */
  private async preflight(action: RpaAction, chatId: string, start: number): Promise<boolean> {
    await this.d.gate.waitUntilOpen();
    if (await this.d.killSwitch.isActive()) {
      await this.log(action, chatId, 'BLOCKED', start);
      this.d.logger.warn({ action, abayaChatId: chatId }, 'acción bloqueada por KillSwitch');
      return false;
    }
    return true;
  }

  private async open(chatId: string): Promise<boolean> {
    const page = this.d.page();
    const chat = new ChatPage(page);
    const list = new ChatListPage(page);
    // El aviso de caso nuevo («ACEPTAR (N)») tapa la pantalla: cerrarlo antes de actuar.
    await list.acceptNewCaseIfShown();
    if ((await chat.currentChatId()) === chatId) return this.interactive();
    if (!(await list.open(chatId))) return false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await chat.currentChatId().catch(() => null)) === chatId) return this.interactive();
      await page.waitForTimeout(100);
    }
    return false;
  }

  /**
   * La pantalla puede mostrar el chat antes de que la aplicación termine de cargar sus
   * scripts: un clic en ese momento se pierde. Esperar la carga completa antes de actuar.
   */
  private async interactive(): Promise<boolean> {
    try {
      await this.d.page().waitForLoadState('load', { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async identityOk(chat: ChatPage, chatId: string, messageId: string) {
    const check = await this.d.guard.verify(chat, chatId);
    if (!check.ok) {
      this.d.logger.error(
        { abayaChatId: chatId, messageId, reason: check.reason },
        'ChatIdentityGuard',
      );
    }
    return check.ok;
  }

  private async uncertain(messageId: string, chatId: string, start: number, reason: string) {
    await this.d.outbound.setStatus(messageId, 'UNCERTAIN');
    await this.log('SEND', chatId, 'UNCERTAIN', start);
    await this.d.alerts.raise('SEND_UNCERTAIN', 'ALTA', { messageId, abayaChatId: chatId, reason });
    return 'UNCERTAIN' as const;
  }

  private async log(
    action: RpaAction,
    chatId: string | null,
    result: RpaActionResult,
    start: number,
  ) {
    await this.d.actionLog.append({
      robotUser: this.d.robotUser,
      action,
      abayaChatId: chatId,
      result,
      durationMs: Date.now() - start,
      traceRef:
        result === 'ERROR' || result === 'UNCERTAIN' ? await this.tracer.capture(action) : null,
      createdAt: this.now(),
    });
  }
}
