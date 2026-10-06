import type { InboundMessage, SenderType } from '@abaya/domain';
import type { Page } from 'playwright';
import { sel } from '../selectors.js';

const SENDER_MAP: Record<string, SenderType> = {
  customer: 'CUSTOMER',
  agent: 'AGENT',
  system: 'SYSTEM',
};

export class ChatPage {
  constructor(private readonly page: Page) {}

  /** Id del chat abierto según la propia pantalla (insumo del ChatIdentityGuard). */
  async currentChatId(): Promise<string | null> {
    const panel = sel.chat.panel(this.page);
    if (!(await panel.isVisible())) return null;
    return panel.getAttribute(sel.chat.panelChatIdAttr);
  }

  async headingText(): Promise<string | null> {
    const h = sel.chat.heading(this.page);
    return (await h.count()) > 0 ? (await h.innerText()).trim() : null;
  }

  /** Lectura del DOM: no modifica la interfaz. */
  async readMessages(): Promise<InboundMessage[]> {
    const chatId = await this.currentChatId();
    if (!chatId) return [];
    const rows = await sel.chat.messages(this.page).evaluateAll(
      (els, attrs) =>
        els.map((el) => ({
          id: el.getAttribute(attrs.id),
          sender: el.getAttribute(attrs.sender),
          ts: el.getAttribute(attrs.ts),
          text: (el as HTMLElement).innerText,
        })),
      { id: sel.chat.messageIdAttr, sender: sel.chat.senderAttr, ts: sel.chat.timestampAttr },
    );
    return rows.map((r, position) => ({
      abayaChatId: chatId,
      ...(r.id ? { messageId: r.id } : {}),
      sender: SENDER_MAP[r.sender ?? ''] ?? 'SYSTEM',
      text: r.text.trim(),
      occurredAt: r.ts ? new Date(r.ts) : new Date(0),
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

  /** @mutating Solo desde BrowserActor (regla 4). */
  async clickSend(): Promise<void> {
    await sel.chat.send(this.page).click();
  }

  /** Mensajes del robot con ese texto ya confirmados por el servidor. */
  async countConfirmedAgentMessages(text: string): Promise<number> {
    const expected = text.trim();
    return (await this.readMessages().catch(() => [])).filter(
      (m) =>
        m.sender === 'AGENT' &&
        m.text === expected &&
        !!m.messageId &&
        !sel.chat.unconfirmedMessageId.test(m.messageId),
    ).length;
  }

  /**
   * Espera a que haya MÁS mensajes confirmados con ese texto que `before` (contados antes de
   * enviar). Contar evita dar por enviado un texto repetido usando un mensaje anterior, y
   * exigir confirmación del servidor evita fiarse del pintado optimista de la interfaz.
   */
  async waitForAgentMessage(text: string, timeoutMs = 10_000, before = 0): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.countConfirmedAgentMessages(text)) > before) return true;
      await this.page.waitForTimeout(200);
    }
    return false;
  }

  /** @mutating Solo desde BrowserActor (regla 4). */
  async closeChat(): Promise<void> {
    await sel.chat.closeChat(this.page).click();
  }
}
