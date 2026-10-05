import type { Page } from 'playwright';
import { sel } from '../selectors.js';

export class NotePage {
  constructor(private readonly page: Page) {}

  /** @mutating Solo desde BrowserActor (regla 4). Devuelve true si el diálogo se cerró tras guardar. */
  async writeNote(note: string, timeoutMs = 10_000): Promise<boolean> {
    const p = this.page;
    await sel.note.open(p).click();
    await sel.note.dialog(p).waitFor({ state: 'visible', timeout: timeoutMs });
    await sel.note.input(p).fill(note);
    await sel.note.save(p).click();
    try {
      await sel.note.dialog(p).waitFor({ state: 'hidden', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
}
