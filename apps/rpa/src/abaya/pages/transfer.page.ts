import type { Page } from 'playwright';
import { sel } from '../selectors.js';

export class TransferPage {
  constructor(private readonly page: Page) {}

  /**
   * @mutating Solo desde BrowserActor (regla 4).
   * Abre el diálogo, elige la cola y confirma. La verificación de que el chat salió de la
   * bandeja la hace quien invoca (sección 6.5).
   */
  async transferTo(queueLabel: string = sel.transfer.backofficeQueueLabel, timeoutMs = 10_000) {
    const p = this.page;
    await sel.transfer.open(p).click();
    await sel.transfer.dialog(p).waitFor({ state: 'visible', timeout: timeoutMs });
    await sel.transfer.queue(p).selectOption({ label: queueLabel });
    await sel.transfer.confirm(p).click();
    await sel.transfer.dialog(p).waitFor({ state: 'hidden', timeout: timeoutMs });
  }
}
