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
   * @mutating Solo desde SessionManager / BrowserActor. Pasa a «Disponible» si no lo está.
   * Devuelve false si el estado no cambió.
   */
  async ensureAvailable(timeoutMs = 10_000): Promise<boolean> {
    if (await this.isReceiving()) return true;
    const p = this.page;
    await sel.state.current(p).click();
    await sel.state.option(p, sel.state.available).click({ timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isReceiving()) return true;
      await p.waitForTimeout(200);
    }
    return false;
  }
}
