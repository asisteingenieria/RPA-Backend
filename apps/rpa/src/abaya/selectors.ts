import type { Locator, Page } from 'playwright';

/**
 * ÚNICO lugar con selectores de Abaya (regla 3).
 *
 * Abaya es ySocial (AngularJS) y casi no tiene atributos ARIA, así que, en este orden (D-012):
 * 1. rol + texto visible (`getByRole`, `getByPlaceholder`, `getByLabel`);
 * 2. ids estables de la aplicación (`#textareaActAsChat`, `divCaseConversationItem{id}`);
 * 3. el `ng-click` de la acción, que es código de la aplicación y no cambia con el estilo.
 * Siguen prohibidas las rutas CSS largas o por posición.
 *
 * Observado en vivo el 09/10/2026 (docs/abaya-mapa-pantallas.md). Los textos se comparan sin
 * mayúsculas: la interfaz los pinta en mayúsculas con CSS («INGRESAR» es «Ingresar» en el DOM).
 */
export const sel = {
  login: {
    /** Login del asesor (el de `/Login.aspx` es el de supervisores). */
    path: '/agent/#/login',
    username: (p: Page) => p.locator('input[name="username"]'),
    password: (p: Page) => p.locator('input[name="password"]'),
    /** ❓ No se vio el doble factor activo (existe en el menú de perfil). */
    otp: (p: Page) => p.locator('[ng-if*="showTwoFactor"] input:visible'),
    submit: (p: Page) => p.getByRole('button', { name: /^ingresar$/i }),
    /** ❓ No se vio un error de login: ySocial avisa con toasts. */
    error: (p: Page) => p.locator('.toast-error, .alert-danger').first(),
  },

  /** Estado del asesor (arriba a la derecha): «Login» al entrar, «Disponible», pausas… */
  state: {
    current: (p: Page) => p.locator('nav span.title').first(),
    option: (p: Page, name: string) =>
      p.locator('a[ng-click="navigation.switchStates(state)"]').filter({
        has: p.getByText(name, { exact: true }),
      }),
    /** Nombre de cada opción del menú de estados (`div.state-name`). */
    optionNames: (p: Page) => p.locator('a[ng-click="navigation.switchStates(state)"] .state-name'),
    available: 'Disponible',
    /** Estado con casos asignados (se pone solo). */
    working: /^Trabajando/,
    /**
     * Pausas a las que vuelve el diagnóstico tras probar «Disponible» si el estado anterior no
     * está en el menú (al entrar es «Login»). Razones auxiliares 0 y 7 del mapa de pantallas.
     */
    pauses: ['Login', 'FinTurno'],
  },

  chatList: {
    /** Un botón por caso asignado en la barra superior. No trae el número del caso en el DOM. */
    items: (p: Page) => p.locator('button.navigation-whatsapp.navigation-bar-button'),
    buttonCss: 'button.navigation-whatsapp.navigation-bar-button',
    unreadClass: 'unread',
    selectedClass: 'selected-message',
    noMessages: (p: Page) => p.locator('div.no-messages'),
    /**
     * Aviso de caso nuevo («SMCC Web Agent») con ACEPTAR y cuenta regresiva: «ACEPTAR (7)».
     * El paréntesis lo distingue del «Aceptar» del cuadro de etiquetas.
     */
    newCaseAccept: (p: Page) => p.getByRole('button', { name: /^aceptar\s*\(\d+\)$/i }),
  },

  chat: {
    header: (p: Page) => p.locator('.social-case-conversation-header'),
    /** El encabezado dice «Caso #NNNNNNNNNN»: es el abayaChatId. */
    headerCaseId: /Caso #(\d+)/,
    messages: (p: Page) => p.locator('[id^="divCaseConversationItem"]'),
    messageIdPrefix: 'divCaseConversationItem',
    /** Clase de la fila → remitente. */
    senderClasses: { client: 'CUSTOMER', agent: 'AGENT', system: 'SYSTEM' },
    bodyCss: 'span.body-text',
    input: (p: Page) => p.locator('#textareaActAsChat'),
    send: (p: Page) => p.locator('a.social-case-reply-as-chat-send'),
    /** Spinner mientras se envía. */
    sending: (p: Page) => p.locator('.social-case-reply-as-chat-send-loading:visible'),
    /**
     * D-014 fase 2: contador «(N)» de adjuntos en cola junto al clip. ySocial lo pinta con
     * `ng-if="caseCtrl.actAsChatInfo.attachmentsQueue.length > 0"` (grabación del 09/10/2026).
     */
    attachmentsQueued: (p: Page) =>
      p.locator('span[ng-if*="actAsChatInfo.attachmentsQueue.length"]'),
    /** Fila de un mensaje con adjunto (`has-attach`); la imagen va en `.attachments-preview`. */
    attachRowClass: 'has-attach',
  },

  /**
   * FINALIZAR ▾ (abajo a la derecha):
   * - «Finalizar» (sin cerrar el caso): el caso pasa a la cola siguiente. Es como termina una
   *   VENTA: la entrega al backoffice (confirmado por el responsable, 09/10/2026).
   * - «Finalizar y cerrar el caso»: pide etiqueta. Es como termina una NO venta.
   */
  finish: {
    open: (p: Page) => p.getByRole('button', { name: /^finalizar$/i }),
    keepCase: (p: Page) => p.locator('a[ng-click="caseCtrl.actAsChatInfo.finishMessage(false)"]'),
    closeCase: (p: Page) => p.locator('a[ng-click="caseCtrl.actAsChatInfo.finishMessage(true)"]'),
    /** «¿Está seguro que desea finalizar la atención del mensaje?» → SI. */
    confirm: (p: Page) => p.locator('button[ng-click="confirm()"]'),
    caseDialog: (p: Page) =>
      p.locator('.modal-dialog').filter({ has: p.getByText(/Detalles del caso #/) }),
    observations: (d: Locator) => d.getByPlaceholder('Observaciones'),
    tagSearch: (d: Locator) => d.getByPlaceholder('Buscar etiqueta...'),
    tag: (d: Locator, label: string) => d.getByRole('checkbox', { name: label, exact: true }),
    accept: (d: Locator) => d.locator('button[ng-click="updateCase()"]'),
    /**
     * Etiqueta con que el robot cierra cada caso que no es venta (cola 147). PROVISIONAL: la
     * elección por motivo falta confirmarla con Claro (mapa de pantallas, pregunta 2).
     */
    tags: {
      SUPPORT: 'SAC - Ecommerce Movil - Detalle plan movil',
      NO_SALE: 'No venta -Ecommerce Movil Reglas de Negocio - Politicas',
      INACTIVE: 'No venta - Ecommerce Movil -Cliente abandona conversación',
    },
  },

  session: {
    /** Señal de sesión viva: el avatar del asesor en la barra superior. */
    inboxMarker: (p: Page) => p.locator('img.user-image'),
    logout: (p: Page) => p.locator('a[ng-click="navigation.signOut()"]'),
  },

  /**
   * Selectores CSS para el MutationObserver de respaldo (corre dentro de la página, donde no
   * existen los locators de Playwright).
   */
  dom: {
    messageItem: '[id^="divCaseConversationItem"]',
    messageIdPrefix: 'divCaseConversationItem',
    body: 'span.body-text',
    caseHeader: '.social-case-conversation-header',
    headerCaseId: 'Caso #(\\d+)',
    /** Clase de la fila → remitente. */
    senders: { client: 'CUSTOMER', agent: 'AGENT', system: 'SYSTEM' },
  },
} as const;

/** Escapa un valor para usarlo dentro de un selector de atributo `[attr="..."]`. */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
