import type { ChatPage } from '../abaya/pages/chat.page.js';

export type IdentityCheck = { ok: true } | { ok: false; reason: string };

/**
 * Regla 1: nunca escribir en un chat sin verificar su identidad.
 * Compara el id que muestra la pantalla con el esperado. Ante cualquier duda: no.
 */
export class ChatIdentityGuard {
  async verify(chat: ChatPage, expectedChatId: string): Promise<IdentityCheck> {
    let shown: string | null;
    try {
      shown = await chat.currentChatId();
    } catch {
      return { ok: false, reason: 'no se pudo leer el chat abierto' };
    }
    if (!shown) return { ok: false, reason: 'no hay chat abierto' };
    if (shown !== expectedChatId) return { ok: false, reason: 'el chat abierto es otro' };
    // Segunda señal independiente: el título visible debe mencionar el mismo id.
    const heading = await chat.headingText().catch(() => null);
    if (heading !== null && !heading.includes(expectedChatId)) {
      return { ok: false, reason: 'el título del chat no coincide' };
    }
    return { ok: true };
  }
}
