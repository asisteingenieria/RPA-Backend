import type { Page } from 'playwright';
import { sel } from '../selectors.js';

/** Estado del asesor (arriba a la derecha). Al iniciar sesión queda en «Login»: sin casos. */
export class AgentStatePage {
  constructor(private readonly page: Page) {}

  async current(): Promise<string | null> {
    const t = sel.state.current(this.page);
    return (await t.count()) ? (await t.innerText()).trim() : null;
  }

  /** Disponible o ya trabajando con casos: puede recibir burbujas. */
  async isReceiving(): Promise<boolean> {
    const s = (await this.current()) ?? '';
    return s === sel.state.available || sel.state.working.test(s);
  }

  /**
   * Nombres de los estados del menú (abre el menú, los lee y lo vuelve a cerrar). Solo nombres
   * de pausas de ySocial: no hay datos de clientes.
   */
  async options(): Promise<string[]> {
    const p = this.page;
    await sel.state.current(p).click();
    const names = (await sel.state.optionNames(p).allInnerTexts()).map((s) => s.trim());
    await sel.state.current(p).click();
    return names.filter(Boolean);
  }

  /**
   * @mutating Solo desde SessionManager / BrowserActor. Pasa a «Disponible» si no lo está.
   * Devuelve false si el estado no cambió.
   */
  async ensureAvailable(timeoutMs = 10_000): Promise<boolean> {
    if (await this.isReceiving()) return true;
    return this.switchTo(sel.state.available, timeoutMs);
  }

  /**
   * @mutating Solo desde SessionManager / BrowserActor. Elige `name` en el menú de estados y
   * espera a que la barra lo muestre. Devuelve false si no cambió.
   */
  async switchTo(name: string, timeoutMs = 10_000): Promise<boolean> {
    const p = this.page;
    await sel.state.current(p).click();
    await sel.state.option(p, name).click({ timeout: timeoutMs });
    const reached = async () =>
      name === sel.state.available ? this.isReceiving() : (await this.current()) === name;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await reached()) return true;
      await p.waitForTimeout(200);
    }
    return false;
  }
}
