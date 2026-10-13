import type { Page } from 'playwright';
import { sel } from '../selectors.js';

/**
 * Menú FINALIZAR del caso abierto. La verificación de que el caso salió de la bandeja la hace
 * quien invoca (secciones 6.5 y 6.6).
 */
export class FinishPage {
  constructor(private readonly page: Page) {}

  /**
   * @mutating Solo desde BrowserActor (regla 4).
   * «Finalizar» sin cerrar el caso: así termina una VENTA, el caso pasa al backoffice.
   */
  async finishKeepCase(timeoutMs = 10_000): Promise<void> {
    const p = this.page;
    await sel.finish.open(p).click();
    await sel.finish.keepCase(p).click({ timeout: timeoutMs });
    await sel.finish.confirm(p).click({ timeout: timeoutMs });
  }

  /**
   * @mutating Solo desde BrowserActor (regla 4).
   * «Finalizar y cerrar el caso» con su etiqueta (y observaciones opcionales): así termina una
   * NO venta. ySocial no deja aceptar sin etiqueta.
   */
  async finishCloseCase(tag: string, observations?: string, timeoutMs = 10_000): Promise<void> {
    const p = this.page;
    await sel.finish.open(p).click();
    await sel.finish.closeCase(p).click({ timeout: timeoutMs });
    await sel.finish.confirm(p).click({ timeout: timeoutMs });
    const dialog = sel.finish.caseDialog(p);
    await dialog.waitFor({ state: 'visible', timeout: timeoutMs });
    if (observations) await sel.finish.observations(dialog).fill(observations);
    await sel.finish.tagSearch(dialog).fill(tag);
    await sel.finish.tag(dialog, tag).check({ timeout: timeoutMs });
    await sel.finish.accept(dialog).click();
    await dialog.waitFor({ state: 'hidden', timeout: timeoutMs });
  }
}
