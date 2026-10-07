import type { AlertPort, RpaAction, RpaActionResult } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import type { Page } from 'playwright';
import { ChatListPage } from '../abaya/pages/chat-list.page.js';
import { ChatPage } from '../abaya/pages/chat.page.js';
import { NotePage } from '../abaya/pages/note.page.js';
import { TransferPage } from '../abaya/pages/transfer.page.js';
import { sel } from '../abaya/selectors.js';
import type { ActionLog } from '../audit/action-log.js';
import type { OutboundRepository } from '../outbound/outbound.repository.js';
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
  | 'NOT_FOUND';

/** Resultado de transferir o cerrar. UNCERTAIN nunca se reintenta a ciegas (regla 2). */
export type HandoffOutcome =
  | { result: 'OK'; noteWritten: boolean }
  | { result: 'BLOCKED_KILL_SWITCH' }
  | { result: 'FAILED'; reason: string; noteWritten: boolean }
  | { result: 'UNCERTAIN'; reason: string; noteWritten: boolean };

export interface TransferRequest {
  abayaChatId: string;
  /** Nota interna (resumen para el backoffice). Se omite si ya se escribió en un intento previo. */
  note?: string;
  queueLabel: string;
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
   * Sección 6.5: abrir chat → verificar identidad → nota interna → transferir a la cola →
   * verificar que el chat salió de la bandeja.
   */
  transfer(req: TransferRequest): Promise<HandoffOutcome> {
    return this.traced(PRIORITY.TRANSFER, async () => {
      const start = Date.now();
      const chatId = req.abayaChatId;
      if (!(await this.preflight('TRANSFER', chatId, start)))
        return { result: 'BLOCKED_KILL_SWITCH' };
      const page = this.d.page();
      const chat = new ChatPage(page);

      if (!(await this.open(chatId))) {
        // ¿Ya no está en la bandeja? Pudo transferirse en un intento previo que murió.
        const stillAssigned = (await new ChatListPage(page).listChats()).some(
          (c) => c.abayaChatId === chatId,
        );
        await this.log('TRANSFER', chatId, stillAssigned ? 'ERROR' : 'UNCERTAIN', start);
        return stillAssigned
          ? { result: 'FAILED', reason: 'no se pudo abrir el chat', noteWritten: false }
          : { result: 'UNCERTAIN', reason: 'el chat ya no está en la bandeja', noteWritten: false };
      }
      if (!(await this.identityOk(chat, chatId, 'transfer'))) {
        await this.log('TRANSFER', chatId, 'UNCERTAIN', start);
        return {
          result: 'UNCERTAIN',
          reason: 'identidad del chat no verificada',
          noteWritten: false,
        };
      }

      let noteWritten = false;
      if (req.note) {
        const noteStart = Date.now();
        try {
          noteWritten = await new NotePage(page).writeNote(req.note);
        } catch {
          noteWritten = false;
        }
        await this.log('NOTE', chatId, noteWritten ? 'OK' : 'ERROR', noteStart);
        if (!noteWritten)
          return { result: 'FAILED', reason: 'no se pudo guardar la nota', noteWritten };
        // Revalidar identidad antes de transferir.
        if (!(await this.identityOk(chat, chatId, 'transfer'))) {
          await this.log('TRANSFER', chatId, 'UNCERTAIN', start);
          return { result: 'UNCERTAIN', reason: 'el chat cambió tras la nota', noteWritten };
        }
      }

      try {
        await new TransferPage(page).transferTo(req.queueLabel);
      } catch {
        // El diálogo pudo quedar a medias: no sabemos si se transfirió.
        await this.log('TRANSFER', chatId, 'UNCERTAIN', start);
        return { result: 'UNCERTAIN', reason: 'error durante la transferencia', noteWritten };
      }
      const gone = await this.waitChatGone(chatId);
      await this.log('TRANSFER', chatId, gone ? 'OK' : 'UNCERTAIN', start);
      return gone
        ? { result: 'OK', noteWritten }
        : {
            result: 'UNCERTAIN',
            reason: 'el chat sigue en la bandeja tras transferir',
            noteWritten,
          };
    });
  }

  /** Cierra un chat que no es venta (sección 6.6) y verifica que salió de la bandeja. */
  closeConversation(abayaChatId: string): Promise<HandoffOutcome> {
    return this.traced(PRIORITY.CLOSE, async () => {
      const start = Date.now();
      if (!(await this.preflight('CLOSE', abayaChatId, start)))
        return { result: 'BLOCKED_KILL_SWITCH' };
      const chat = new ChatPage(this.d.page());
      if (!(await this.open(abayaChatId)) || !(await this.identityOk(chat, abayaChatId, 'close'))) {
        await this.log('CLOSE', abayaChatId, 'UNCERTAIN', start);
        return { result: 'UNCERTAIN', reason: 'chat no verificado', noteWritten: false };
      }
      try {
        await chat.closeChat();
      } catch {
        await this.log('CLOSE', abayaChatId, 'UNCERTAIN', start);
        return { result: 'UNCERTAIN', reason: 'error al cerrar', noteWritten: false };
      }
      const gone = await this.waitChatGone(abayaChatId);
      await this.log('CLOSE', abayaChatId, gone ? 'OK' : 'UNCERTAIN', start);
      return gone
        ? { result: 'OK', noteWritten: false }
        : { result: 'UNCERTAIN', reason: 'el chat sigue en la bandeja', noteWritten: false };
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
    if ((await chat.currentChatId()) === chatId) return this.interactive();
    const list = new ChatListPage(page);
    if (!(await sel.chatList.item(page, chatId).count())) return false;
    await list.open(chatId);
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
