import type { InboundMessage, SenderType } from '@abaya/domain';
import type { Page } from 'playwright';
import { sel } from '../selectors.js';

/**
 * Para comparar lo enviado con lo publicado: ySocial pinta los emojis como imágenes y el formato de
 * WhatsApp (*negrita*, _cursiva_, ~tachado~) como etiquetas, y puede reflujar los espacios. No
 * cuentan los espacios, las marcas de formato ni el selector de variante de los emojis.
 */
const normalize = (s: string) =>
  s
    .normalize('NFC')
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, '');

/** ¿Es el mismo texto, tal como lo muestra ySocial? */
export const sameText = (a: string, b: string) => normalize(a) === normalize(b);

/** Cómo envía el asesor en ySocial (ver `sel.chat.sendModeService`). */
export type SendMode = 'click' | 'enter' | 'both';

export class ChatPage {
  constructor(private readonly page: Page) {}

  /** Número del caso abierto según el encabezado «Caso #N» (insumo del ChatIdentityGuard). */
  async currentChatId(): Promise<string | null> {
    const text = await this.headingText();
    return text ? (sel.chat.headerCaseId.exec(text)?.[1] ?? null) : null;
  }

  async headingText(): Promise<string | null> {
    const h = sel.chat.header(this.page).first();
    if (!(await h.count()) || !(await h.isVisible())) return null;
    return (await h.innerText()).trim();
  }

  /**
   * Lectura del DOM: no modifica la interfaz. La pantalla no trae la hora exacta del mensaje
   * (solo «8:54»): `occurredAt` es el momento de la lectura. La hora real llega por la red.
   */
  async readMessages(): Promise<InboundMessage[]> {
    const chatId = await this.currentChatId();
    if (!chatId) return [];
    const rows = await sel.chat.messages(this.page).evaluateAll(
      (els, cfg) =>
        els.map((el) => {
          const cls = Object.keys(cfg.senders).find((c) => el.classList.contains(c));
          return {
            id: el.id.slice(cfg.prefix.length),
            sender: cls ? cfg.senders[cls as keyof typeof cfg.senders] : 'SYSTEM',
            text: (() => {
              // Emojis: ySocial los pinta como <img class="emoji" alt="😀">; el texto es el alt.
              const body = el.querySelector(cfg.body);
              if (!body) return '';
              const copy = body.cloneNode(true) as HTMLElement;
              copy
                .querySelectorAll(cfg.emoji)
                .forEach((i) => i.replaceWith(i.getAttribute('alt') ?? ''));
              copy.querySelectorAll(cfg.br).forEach((b) => b.replaceWith('\n'));
              return copy.textContent ?? '';
            })(),
          };
        }),
      {
        prefix: sel.chat.messageIdPrefix,
        senders: sel.chat.senderClasses,
        body: sel.chat.bodyCss,
        emoji: sel.chat.emojiCss,
        br: sel.chat.lineBreakCss,
      },
    );
    const now = new Date();
    return rows.map((r, position) => ({
      abayaChatId: chatId,
      ...(r.id ? { messageId: r.id } : {}),
      sender: r.sender as SenderType,
      text: r.text.trim(),
      occurredAt: now,
      position,
    }));
  }

  /** Últimos textos enviados por el asesor/robot (para idempotencia en pantalla, sección 6.4). */
  async lastAgentTexts(n: number): Promise<string[]> {
    const msgs = await this.readMessages();
    return msgs
      .filter((m) => m.sender === 'AGENT')
      .slice(-n)
      .map((m) => m.text);
  }

  /** @mutating Solo desde BrowserActor (regla 4). Respeta saltos de línea. */
  async typeMessage(text: string): Promise<void> {
    await sel.chat.input(this.page).fill(text);
  }

  /**
   * @mutating Solo desde BrowserActor (regla 4). D-014 fase 2: pega la imagen en la caja, como
   * la asesora. ySocial escucha «pegar» en toda la página y, si lo pegado trae un archivo (y no
   * texto), lo agrega a la cola de adjuntos; al enviar lo sube y va con el texto como pie de foto.
   */
  async pasteImage(bytes: Uint8Array, mime: string, fileName: string): Promise<void> {
    await sel.chat.input(this.page).evaluate(
      (el, f) => {
        const bin = atob(f.b64);
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([data], f.name, { type: f.mime }));
        (el as HTMLElement).focus();
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      },
      { b64: Buffer.from(bytes).toString('base64'), mime, name: fileName },
    );
  }

  /** Adjuntos en cola en la caja de respuesta (el contador «(N)»; 0 si no se ve). */
  async queuedAttachments(): Promise<number> {
    const badge = sel.chat.attachmentsQueued(this.page).first();
    if (!(await badge.count()) || !(await badge.isVisible())) return 0;
    return Number(/\d+/.exec(await badge.innerText())?.[0] ?? 0);
  }

  /** Espera a que la cola de adjuntos tenga exactamente `n` (tras pegar). */
  async waitForQueuedAttachments(n: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.queuedAttachments()) === n) return true;
      await this.page.waitForTimeout(100);
    }
    return false;
  }

  /** @mutating Solo desde BrowserActor (regla 4). */
  async clickSend(): Promise<void> {
    await sel.chat.send(this.page).click();
  }

  /** @mutating Solo desde BrowserActor (regla 4). Enter en la caja (Shift+Enter sería salto). */
  async pressEnterToSend(): Promise<void> {
    await sel.chat.input(this.page).press('Enter');
  }

  /**
   * Modo de envío del usuario en ySocial, leído del servicio de AngularJS (no cambia nada).
   * null si no se puede leer; sin valor guardado ySocial se comporta como «both».
   */
  async sendMode(): Promise<SendMode | null> {
    const mode = await this.page
      .evaluate((service) => {
        type Settings = { settings?: { agent?: { settings?: { sendMode?: unknown } } } };
        type Ng = {
          element(el: Element): { injector?(): { get(name: string): Settings } | undefined };
        };
        const ng = (window as unknown as { angular?: Ng }).angular;
        const injector = ng?.element(document.body).injector?.();
        if (!injector) return null;
        const value = injector.get(service)?.settings?.agent?.settings?.sendMode;
        return typeof value === 'string' ? value.toLowerCase() : 'both';
      }, sel.chat.sendModeService)
      .catch(() => null);
    return mode === 'click' || mode === 'enter' || mode === 'both' ? mode : null;
  }

  /** Lo que hay escrito en la caja de respuesta. */
  async composerText(): Promise<string> {
    return sel.chat.input(this.page).inputValue();
  }

  /** ySocial está enviando (spinner junto a la flecha). */
  async isSending(): Promise<boolean> {
    return (await sel.chat.sending(this.page).count()) > 0;
  }

  /** La caja conserva exactamente este texto: no salió nada (Enter o clic ignorados). */
  async composerStill(text: string): Promise<boolean> {
    const now = await this.composerText().catch(() => null);
    return now !== null && normalize(now) === normalize(text) && !(await this.isSending());
  }

  /**
   * Mensajes del robot con ese texto ya confirmados por el servidor. ySocial pinta la fila
   * cuando el servidor la guarda, con su id numérico (`divCaseConversationItem{id}`).
   */
  async countConfirmedAgentMessages(text: string): Promise<number> {
    const expected = normalize(text);
    return (await this.readMessages().catch(() => [])).filter(
      (m) =>
        m.sender === 'AGENT' &&
        normalize(m.text) === expected &&
        !!m.messageId &&
        /^\d+$/.test(m.messageId),
    ).length;
  }

  /**
   * D-014 fase 2: mensajes del robot CON ADJUNTO y ese pie de foto, confirmados por el servidor
   * (fila `has-attach` con id numérico). Un pie de foto vacío cuenta las imágenes sin texto.
   */
  async countConfirmedAgentImages(caption: string): Promise<number> {
    const expected = normalize(caption);
    const rows = await sel.chat
      .messages(this.page)
      .evaluateAll(
        (els, cfg) =>
          els.map((el) => ({
            id: el.id.slice(cfg.prefix.length),
            agent: el.classList.contains('agent'),
            attach: el.classList.contains(cfg.attach),
            text: (() => {
              const body = el.querySelector(cfg.body);
              if (!body) return '';
              const copy = body.cloneNode(true) as HTMLElement;
              copy
                .querySelectorAll(cfg.emoji)
                .forEach((i) => i.replaceWith(i.getAttribute('alt') ?? ''));
              copy.querySelectorAll(cfg.br).forEach((b) => b.replaceWith('\n'));
              return copy.textContent ?? '';
            })(),
          })),
        {
          prefix: sel.chat.messageIdPrefix,
          attach: sel.chat.attachRowClass,
          body: sel.chat.bodyCss,
          emoji: sel.chat.emojiCss,
          br: sel.chat.lineBreakCss,
        },
      )
      .catch(() => []);
    return rows.filter(
      (r) => r.agent && r.attach && /^\d+$/.test(r.id) && normalize(r.text) === expected,
    ).length;
  }

  async waitForAgentImage(caption: string, timeoutMs = 10_000, before = 0): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.countConfirmedAgentImages(caption)) > before) return true;
      await this.page.waitForTimeout(200);
    }
    return false;
  }

  /**
   * Espera a que haya MÁS mensajes confirmados con ese texto que `before` (contados antes de
   * enviar). Contar evita dar por enviado un texto repetido usando un mensaje anterior.
   */
  async waitForAgentMessage(text: string, timeoutMs = 10_000, before = 0): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.countConfirmedAgentMessages(text)) > before) return true;
      await this.page.waitForTimeout(200);
    }
    return false;
  }
}
