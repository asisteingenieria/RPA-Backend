import type { Locator, Page } from 'playwright';
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
    try {
      if (observations) await sel.finish.observations(dialog).fill(observations);
      await sel.finish.tagSearch(dialog).fill(tag);
      await this.revealTag(dialog, tag, timeoutMs);
      const box = sel.finish.tag(dialog, tag);
      await box.check({ timeout: timeoutMs });
      if (!(await box.isChecked())) throw new Error('etiqueta no marcada');
      await sel.finish.accept(dialog).click({ timeout: timeoutMs });
      await dialog.waitFor({ state: 'hidden', timeout: timeoutMs });
    } catch (err) {
      // Sin «Aceptar» el caso sigue abierto y en la bandeja: se cancela el cuadro para no dejar la
      // pantalla tapada (bloquearía los demás chats). Quien invoca lo reporta como incierto.
      await sel.finish
        .cancel(dialog)
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Abre los grupos cerrados del árbol hasta que la etiqueta exista en la página (en ySocial
   * buscar filtra pero no abre los grupos). Abre solo los cerrados: nunca cierra uno abierto.
   */
  private async revealTag(dialog: Locator, tag: string, timeoutMs: number): Promise<void> {
    const box = sel.finish.tag(dialog, tag);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await box.isVisible()) return;
      const closed = sel.finish.collapsedGroups(dialog);
      if (await closed.count()) await closed.first().click({ timeout: 2_000 });
      else await this.page.waitForTimeout(200);
    }
  }
}
