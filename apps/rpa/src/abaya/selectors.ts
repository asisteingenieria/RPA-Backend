import type { Locator, Page } from 'playwright';

/**
 * ÚNICO lugar con selectores de Abaya (regla 3).
 * Solo selectores semánticos: getByRole, getByLabel, getByText o atributos data-*.
 * Prohibidas las rutas CSS largas o por posición.
 *
 * PROVISIONAL: definidos contra el Abaya simulado (apps/rpa/test/mock-abaya). En F1 real se
 * reemplazan con lo descubierto en docs/abaya-mapa-pantallas.md sin tocar los page objects.
 */
export const sel = {
  login: {
    username: (p: Page) => p.getByLabel('Usuario'),
    password: (p: Page) => p.getByLabel('Contraseña'),
    otp: (p: Page) => p.getByLabel('Código de verificación'),
    submit: (p: Page) => p.getByRole('button', { name: 'Ingresar' }),
    error: (p: Page) => p.getByRole('alert'),
  },

  chatList: {
    root: (p: Page) => p.getByRole('navigation', { name: 'Chats asignados' }),
    items: (p: Page) => sel.chatList.root(p).locator('[data-chat-id]'),
    item: (p: Page, chatId: string) =>
      sel.chatList.root(p).locator(`[data-chat-id="${cssEscape(chatId)}"]`),
    openButton: (item: Locator) => item.getByRole('button'),
    unreadBadge: (item: Locator) => item.locator('[data-unread]'),
    chatIdAttr: 'data-chat-id',
    unreadAttr: 'data-unread',
  },

  chat: {
    panel: (p: Page) => p.getByRole('region', { name: 'Conversación' }),
    panelChatIdAttr: 'data-chat-id',
    heading: (p: Page) => sel.chat.panel(p).getByRole('heading', { level: 2 }),
    messageList: (p: Page) => p.getByRole('list', { name: 'Mensajes' }),
    messages: (p: Page) => sel.chat.messageList(p).locator('[data-message-id]'),
    messageIdAttr: 'data-message-id',
    senderAttr: 'data-sender',
    timestampAttr: 'data-timestamp',
    /**
     * Mensaje pintado por la interfaz antes de que el servidor lo confirme (envío optimista).
     * No cuenta como verificado. PROVISIONAL: en Abaya real puede ser un ícono de estado.
     */
    unconfirmedMessageId: /^local-/,
    input: (p: Page) => p.getByRole('textbox', { name: 'Escribe un mensaje' }),
    send: (p: Page) => p.getByRole('button', { name: 'Enviar' }),
    closeChat: (p: Page) => p.getByRole('button', { name: 'Cerrar chat' }),
  },

  note: {
    open: (p: Page) => p.getByRole('button', { name: 'Nota interna' }),
    dialog: (p: Page) => p.getByRole('dialog', { name: 'Nota interna' }),
    input: (p: Page) => sel.note.dialog(p).getByRole('textbox', { name: 'Nota' }),
    save: (p: Page) => sel.note.dialog(p).getByRole('button', { name: 'Guardar nota' }),
  },

  transfer: {
    open: (p: Page) => p.getByRole('button', { name: 'Transferir', exact: true }),
    dialog: (p: Page) => p.getByRole('dialog', { name: 'Transferir chat' }),
    queue: (p: Page) => sel.transfer.dialog(p).getByLabel('Cola'),
    confirm: (p: Page) =>
      sel.transfer.dialog(p).getByRole('button', { name: 'Confirmar transferencia' }),
    /** Etiqueta visible de la cola de backoffice (confirmar con Claro, pregunta 13). */
    backofficeQueueLabel: 'Backoffice ventas',
    /** Cola humana para casos que la IA no puede manejar (pregunta 12). */
    humanQueueLabel: 'Asesores humanos',
  },

  session: {
    /** Señal de sesión viva: la bandeja de chats es visible. */
    inboxMarker: (p: Page) => sel.chatList.root(p),
    logout: (p: Page) => p.getByRole('link', { name: 'Salir' }),
  },

  /**
   * Selectores CSS por atributo para el MutationObserver de respaldo (corre dentro de la
   * página, donde no existen los locators de Playwright). Solo atributos semánticos.
   */
  dom: {
    messageItem: '[data-message-id]',
    chatContainer: '[data-chat-id]',
    chatListItem: 'nav[aria-label="Chats asignados"] [data-chat-id]',
    attrs: {
      messageId: 'data-message-id',
      chatId: 'data-chat-id',
      sender: 'data-sender',
      timestamp: 'data-timestamp',
    },
    /** Valores de `data-sender` → remitente del dominio. */
    senders: { customer: 'CUSTOMER', agent: 'AGENT', system: 'SYSTEM' },
  },
} as const;

/** Escapa un valor para usarlo dentro de un selector de atributo `[attr="..."]`. */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
