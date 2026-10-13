import type { Page } from 'playwright';
import { sel } from '../selectors.js';

export interface ChatListItem {
  abayaChatId: string;
  unread: number;
  active: boolean;
}

interface ButtonRow {
  id: string | null;
  unread: boolean;
  active: boolean;
}

/**
 * Bandeja de ySocial: un botón por caso en la barra superior. El botón no trae el número del
 * caso en el DOM; la consola (AngularJS) lo tiene en el modelo del botón
 * (`msg.message.case.id`) y se lee sin hacer clic.
 */
export class ChatListPage {
  constructor(private readonly page: Page) {}

  async isVisible(): Promise<boolean> {
    return sel.session.inboxMarker(this.page).isVisible();
  }

  /** Lectura: no modifica la interfaz. */
  async listChats(): Promise<ChatListItem[]> {
    return (await this.buttons())
      .filter((r): r is ButtonRow & { id: string } => !!r.id)
      .map((r) => ({ abayaChatId: r.id, unread: r.unread ? 1 : 0, active: r.active }));
  }

  /**
   * @mutating Solo desde BrowserActor (regla 4). Cierra antes el aviso de caso nuevo
   * («ACEPTAR (N)»), que tapa la pantalla. Devuelve false si el caso no está en la bandeja.
   */
  async open(abayaChatId: string): Promise<boolean> {
    await this.acceptNewCaseIfShown();
    const i = (await this.buttons()).findIndex((r) => r.id === abayaChatId);
    if (i < 0) return false;
    await sel.chatList.items(this.page).nth(i).click();
    return true;
  }

  /** @mutating Solo desde BrowserActor (regla 4). Devuelve true si había aviso. */
  async acceptNewCaseIfShown(): Promise<boolean> {
    const accept = sel.chatList.newCaseAccept(this.page);
    if (!(await accept.isVisible().catch(() => false))) return false;
    await accept.click().catch(() => undefined); // pudo cerrarse solo al terminar la cuenta
    return true;
  }

  /** Botones de la barra en orden, con el número de caso leído del modelo de AngularJS. */
  private buttons(): Promise<ButtonRow[]> {
    return this.page.evaluate(
      (cfg) => {
        type Scope = { msg?: { message?: { case?: { id?: unknown } } } };
        type Ng = { element(el: Element): { scope(): Scope | undefined } };
        const ng = (window as unknown as { angular?: Ng }).angular;
        return Array.from(document.querySelectorAll(cfg.css)).map((b) => {
          const id = ng?.element(b).scope()?.msg?.message?.case?.id;
          return {
            id: id === undefined || id === null ? null : String(id),
            unread: b.classList.contains(cfg.unread),
            active: b.classList.contains(cfg.selected),
          };
        });
      },
      {
        css: sel.chatList.buttonCss,
        unread: sel.chatList.unreadClass,
        selected: sel.chatList.selectedClass,
      },
    );
  }
}
