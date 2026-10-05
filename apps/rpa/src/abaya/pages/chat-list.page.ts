import type { Page } from 'playwright';
import { sel } from '../selectors.js';

export interface ChatListItem {
  abayaChatId: string;
  unread: number;
  active: boolean;
}

export class ChatListPage {
  constructor(private readonly page: Page) {}

  async isVisible(): Promise<boolean> {
    return sel.chatList.root(this.page).isVisible();
  }

  /** Lectura: no modifica la interfaz. */
  async listChats(): Promise<ChatListItem[]> {
    const items = await sel.chatList.items(this.page).all();
    const out: ChatListItem[] = [];
    for (const item of items) {
      const id = await item.getAttribute(sel.chatList.chatIdAttr);
      if (!id) continue;
      const badge = sel.chatList.unreadBadge(item);
      const unreadRaw =
        (await badge.count()) > 0 ? await badge.getAttribute(sel.chatList.unreadAttr) : '0';
      const current = await sel.chatList.openButton(item).getAttribute('aria-current');
      out.push({
        abayaChatId: id,
        unread: Number(unreadRaw ?? 0) || 0,
        active: current === 'true',
      });
    }
    return out;
  }

  /** @mutating Solo desde BrowserActor (regla 4). */
  async open(abayaChatId: string): Promise<void> {
    const item = sel.chatList.item(this.page, abayaChatId);
    await sel.chatList.openButton(item).click();
  }
}
