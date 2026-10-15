/**
 * Markup del Abaya SIMULADO, imitando la consola del asesor de ySocial observada el 09/10/2026
 * (docs/abaya-mapa-pantallas.md): botones de caso en la barra superior, aviso «ACEPTAR (N)»,
 * encabezado «Caso #N», filas `divCaseConversationItem{id}` con clase client/agent/system,
 * `#textareaActAsChat`, menú FINALIZAR y cuadro «Detalles del caso» con etiquetas.
 *
 * AngularJS no se reproduce: un `angular.element(el).scope()` mínimo expone lo mismo que el
 * robot lee en la consola real (`msg.message.case.id`, `msg.message.read`).
 *
 * Todos los datos son sintéticos. Ids numéricos, como en ySocial.
 */

export type MockSender = 'customer' | 'agent' | 'system';

export interface MockMessage {
  id: string;
  sender: MockSender;
  text: string;
  sentAt: string; // ISO
  /** D-014 fase 2: adjunto (la imagen que pegó el asesor); `text` es su pie de foto. */
  attachment?: { mime: string; fileName: string; size: number };
}

/**
 * Modo de envío del asesor en ySocial (`settings.agent.settings.sendMode`): «click» ignora Enter,
 * «enter» ignora la flecha; sin valor (null) ySocial acepta los dos.
 */
export type MockSendMode = 'click' | 'enter' | 'both';

export interface MockChat {
  id: string;
  alias: string;
  unread: number;
  messages: MockMessage[];
}

/**
 * Etiquetas de cierre de la cola de la campaña: el árbol E-COMMERCE MOVIL (No Venta y SAC) tal como
 * se ve en la grabación del 09/10/2026 (D-025).
 */
export const MOCK_TAGS = [
  'No venta - Ecommerce Movil - Caída de IdClaro',
  'No venta - Ecommerce Movil - Cliente carrusel < 90 dias',
  'No venta - Ecommerce Movil - Cliente interesado hogar -T&T',
  'No venta - Ecommerce Movil - Cliente prefiere Prepago',
  'No venta - Ecommerce Movil - Mejor oferta otros operadores',
  'No venta - Ecommerce Movil - Rechazado por validacion de identidad',
  'No venta - Ecommerce Movil- Caída de Poliedro',
  'No venta - Ecommerce Movil -Cliente abandona conversación',
  'No venta -Ecommerce Movil - Bot Respuesta Autómatica -Ocioso',
  'No venta -Ecommerce Movil Reglas de Negocio - Politicas',
  'SAC - Ecommerce Movil - Cambio de plan',
  'SAC - Ecommerce Movil - Cancelacion Hogar',
  'SAC - Ecommerce Movil - Cancelacion Movil',
  'SAC - Ecommerce Movil - Consulta - Radicacion PQR',
  'SAC - Ecommerce Movil - Demora entrega SIM CARD',
  'SAC - Ecommerce Movil - Detalle plan hogar',
  'SAC - Ecommerce Movil - Detalle plan movil',
  'SAC - Ecommerce Movil - Facturacion',
  'SAC - Ecommerce Movil - Pagos y recargas',
  'SAC - Ecommerce Movil - Retencion',
  'SAC - Ecommerce Movil - Soporte',
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
  body { font-family: sans-serif; margin: 0; }
  nav { display: flex; gap: 8px; align-items: center; padding: 4px 8px; background: #eee; }
  .navigation-bar-button { width: 48px; height: 40px; }
  .navigation-bar-button.unread { outline: 2px solid orange; }
  .navigation-bar-button.selected-message { background: #6c6; }
  .agent-state { margin-left: auto; }
  .state-menu, .dropdown-menu, .profile-menu { list-style: none; padding: 4px; background: #fff; border: 1px solid #ccc; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: flex-start; justify-content: center; }
  .modal[hidden] { display: none; }
  .modal-dialog { background: #fff; padding: 12px; margin-top: 40px; min-width: 320px; }
  img.user-image { width: 32px; height: 32px; display: inline-block; background: #c9c; }
  span.body-text { white-space: pre-wrap; }
  .attachment-image img { max-height: 120px; }
`;

export function loginHtml(opts: { error?: string; mfa?: boolean; server?: boolean } = {}): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>SMCC Web Agent</title><style>${STYLE}</style></head>
<body>
<main class="login">
  <form name="login.form" novalidate autocomplete="off">
    <!-- Como en ySocial real: usuario y contraseña dentro del bloque «sin doble factor». -->
    <div ng-if="!login.showTwoFactor">
      <div class="form-group"><input name="username" class="form-control loginFormInput" placeholder="Usuario"></div>
      <div class="form-group"><input type="password" name="password" class="form-control loginFormInput" placeholder="Contraseña"></div>
    </div>
    ${opts.mfa ? '<div ng-if="login.showTwoFactor"><input name="otp" placeholder="Código" inputmode="numeric"></div>' : ''}
    <button class="btn btn-flat" type="submit">Ingresar</button>
  </form>
  <div class="toast-error" ${opts.error ? '' : 'hidden'}>${esc(opts.error ?? '')}</div>
</main>
<script>window.__mockServer = ${opts.server ? 'true' : 'false'};</script>
<script>
(() => {
  const form = document.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!window.__mockServer) return; // modo estático: no navega
    const v = (n) => form.querySelector('[name="' + n + '"]')?.value ?? '';
    const r = await fetch('/services/agents/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: v('username'), password: v('password'), otp: v('otp') }),
    });
    if (r.ok) { location.reload(); return; }
    const err = document.querySelector('.toast-error');
    err.textContent = r.status === 409
      ? 'El agente ya se encuentra conectado, no puede ingresar nuevamente.'
      : 'Usuario o contraseña incorrectos';
    err.hidden = false;
  });
})();
</script>
</body></html>`;
}

/**
 * Consola del asesor. `mode`:
 * - static: para page.setContent (sin servidor), todo ocurre en el DOM con los datos embebidos;
 * - server: habla con mock-server.ts con las mismas rutas de ySocial, lo que genera el tráfico
 *   que escucha el InboundWatcher.
 */
export function inboxHtml(
  chats: MockChat[],
  activeId?: string,
  mode: 'static' | 'server' = 'static',
  opts: { state?: string; sendMode?: MockSendMode; hideSendMode?: boolean } = {},
): string {
  const data = JSON.stringify({
    chats,
    activeId: activeId ?? null,
    tags: MOCK_TAGS,
    sendMode: opts.sendMode ?? null,
    hideSendMode: !!opts.hideSendMode,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>SMCC Web Agent</title><style>${STYLE}</style></head>
<body>
<nav class="navbar">
  <div class="navigation-bar"></div>
  <div class="agent-state">
    <a class="button" data-toggle="state"><span class="title hidden-xs">${esc(opts.state ?? 'Login')}</span></a>
    <ul class="state-menu" hidden>
      <li><a ng-click="navigation.switchStates(state)"><div><div class="state-name">Disponible</div></div></a></li>
      <li><a ng-click="navigation.switchStates(state)"><div><div class="state-name">Almuerzo</div></div></a></li>
      <li><a ng-click="navigation.switchStates(state)"><div><div class="state-name">FinTurno</div></div></a></li>
    </ul>
  </div>
  <a data-toggle="profile"><img class="user-image" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
  <div class="profile-menu" hidden>
    <!-- Como en ySocial real: el panel del perfil repite el avatar (dos img.user-image). -->
    <img class="user-image" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <a class="button-profile col-xs-3" ng-hide="navigation.removeLogoutButton()" ng-click="navigation.signOut()">Salir</a>
  </div>
</nav>
<main id="main"></main>

<div class="modal" data-modal="alert" hidden><div class="modal-dialog">
  <p>SMCC Web Agent</p>
  <div class="alert-info">TiendaOnLine - Usuario desbordado por opción de venta</div>
  <button class="btn btn-flat btn-action" type="button">ACEPTAR (<span class="button-progress-remaining">7</span>)</button>
</div></div>

<div class="modal" data-modal="signout" hidden><div class="modal-dialog">
  <p>Cierre de sesión</p>
  <p>¿Está seguro que desea cerrar sesión?</p>
  <button class="btn btn-flat btn-action" type="button" ng-click="signOutConfirm()">Aceptar</button>
  <button class="btn btn-flat" type="button">Cancelar</button>
</div></div>

<div class="modal" data-modal="confirm" hidden><div class="modal-dialog">
  <p>Finalización de atención de mensaje</p>
  <p>¿Está seguro que desea finalizar la atención del mensaje?</p>
  <button class="btn btn-flat btn-action" type="button" ng-click="confirm()">Si</button>
  <button class="btn btn-flat" type="button" ng-click="no()">No</button>
</div></div>

<div class="modal" data-modal="case" hidden><div class="modal-dialog">
  <p class="modal-title">Detalles del caso #<span data-case-title></span></p>
  <label>Observaciones</label>
  <textarea class="form-control" placeholder="Observaciones"></textarea>
  <span>Etiquetas</span>
  <input class="form-control" placeholder="Buscar etiqueta...">
  <ul class="ivh-treeview"></ul>
  <button type="button" ng-click="updateCase()" class="btn btn-action btn-flat">Aceptar</button>
  <button type="button" class="btn btn-flat" ng-click="cancel()">Cancelar</button>
</div></div>

<script>window.__mockServer = ${mode === 'server' ? 'true' : 'false'};</script>
<script>${consoleScript(data)}</script>
</body></html>`;
}

function consoleScript(data: string): string {
  return `
(() => {
  const DATA = ${data};
  const SERVER = window.__mockServer === true;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const hhmm = (iso) => { const d = new Date(iso); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // AngularJS mínimo: lo que el robot lee de la consola real.
  // Modo de envío: el robot lo lee del injector (\`settingsService\`), como en ySocial real;
  // hideSendMode simula que no se puede leer (sin injector) aunque el modo siga vigente.
  const settingsService = { settings: { agent: { settings: DATA.sendMode ? { sendMode: DATA.sendMode } : {} } } };
  const injector = DATA.hideSendMode ? undefined : { get: (n) => (n === 'settingsService' ? settingsService : undefined) };
  window.angular = { element: (el) => ({ scope: () => el && el.__scope, injector: () => injector }) };
  const enterSends = () => DATA.sendMode !== 'click';
  const clickSends = () => DATA.sendMode !== 'enter';

  // ---------- datos: servidor simulado o en memoria (modo estático) ----------
  let cases = DATA.chats.map((c) => ({ id: c.id, unread: c.unread, lastId: c.messages.at(-1)?.id ?? c.id }));
  const local = new Map(DATA.chats.map((c) => [c.id, c]));
  let selected = DATA.activeId;
  let shownCase = DATA.activeId; // lo que se ve en pantalla (puede diferir: misroute)
  let messages = [];
  /** Cola de adjuntos de la caja (ySocial: caseCtrl.actAsChatInfo.attachmentsQueue). */
  let queue = [];
  const known = new Set(cases.map((c) => c.id));
  let seq = 900000;

  const api = async (path, body) => {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { location.reload(); throw new Error('401'); }
    return r;
  };

  async function fetchCase(id) {
    if (!SERVER) {
      const c = local.get(id);
      return c ? { id: c.id, messages: c.messages } : null;
    }
    const r = await api('/services/messaging/case?id=' + encodeURIComponent(id) + '&socialUserProfileId=1');
    if (!r.ok) return null;
    const j = await r.json();
    const c = j.Result.Case;
    return {
      id: String(c.ID),
      messages: c.Messages.map((m) => ({
        id: String(m.ID),
        sender: !m.IsReply ? 'customer' : m.ReplySource === 3 ? 'agent' : 'system',
        text: m.Body || '',
        sentAt: m.Date,
        ...(m.HasAttach && m.Attachments?.[0] ? { attachment: { mime: m.Attachments[0].MimeType, fileName: m.Attachments[0].FileName, size: m.Attachments[0].FileSize } } : {}),
      })),
    };
  }

  // ---------- pintado ----------
  function renderBar() {
    const bar = $('.navigation-bar');
    bar.innerHTML = '';
    for (const c of cases) {
      const b = document.createElement('button');
      b.className = 'navigation-whatsapp navigation-bar-button' + (c.unread ? ' unread' : '') + (c.id === selected ? ' selected-message' : '');
      b.setAttribute('ng-click', 'navigation.markAsRead(msg.message)');
      b.innerHTML = '<div><i class="fab fa-whatsapp navigation-bar-icons" aria-hidden="true"></i></div>';
      b.__scope = { msg: { message: { id: c.lastId, read: !c.unread, case: { id: Number(c.id) } } } };
      b.addEventListener('click', () => void select(c.id));
      bar.appendChild(b);
    }
  }

  function renderMain() {
    const main = $('#main');
    if (!shownCase) {
      const pending = cases.some((c) => c.unread);
      main.innerHTML = pending
        ? '<div class="has-messages-to-answer">HEY! Usted tiene ' + cases.filter((c) => c.unread).length + ' mensaje sin responder</div>'
        : '<div class="no-messages">¡NO HAY MENSAJES PARA RESPONDER!</div>';
      return;
    }
    main.innerHTML =
      '<div class="box box-widget social-case-conversation">' +
      '<div class="box-widget-header social-case-conversation-header"><span>Caso #' + esc(shownCase) + '</span></div>' +
      '<div class="social-case-conversation-body">' + messagesHtml() + '</div>' +
      '<div class="social-case-reply-as-chat-compose">' +
      '<textarea class="form-control" rows="1" id="textareaActAsChat" placeholder="Escriba un mensaje"></textarea>' +
      '<a class="social-case-reply-as-chat-send" ng-click="caseCtrl.handleSendClick($event)">&#10148;</a>' +
      '<div class="social-case-reply-as-chat-send-loading" hidden>enviando…</div>' +
      '<div class="social-case-reply-as-chat-buttons">' +
      '<button type="button" class="btn btn-flat btn-default" ng-click="caseCtrl.actAsChatAttachFile()" title="Adjuntar">&#128206;' +
      '<span class="bold" ng-if="caseCtrl.actAsChatInfo.attachmentsQueue.length > 0"' + (queue.length ? '' : ' hidden') + '>(' + queue.length + ')</span></button>' +
      '</div>' +
      '</div>' +
      '<div class="finish">' +
      '<button class="btn btn-flat btn-action" type="button" data-toggle="finish"><span class="ng-binding">FINALIZAR</span></button>' +
      '<ul class="dropdown-menu" hidden>' +
      '<li><a ng-click="caseCtrl.actAsChatInfo.finishMessage(false)">Finalizar</a></li>' +
      '<li><a ng-click="caseCtrl.actAsChatInfo.finishMessage(true)">Finalizar y cerrar el caso</a></li>' +
      '</ul></div></div>';
  }

  function messagesHtml() {
    return messages.map((m) =>
      '<div id="divCaseConversationItem' + esc(m.id) + '" class="case-conversation-item msg-row ' + (m.sender === 'customer' ? 'client' : m.sender) + (m.attachment ? ' has-attach' : '') + '">' +
      '<div class="conversation-message">' +
      // Como ySocial: sin texto no se pinta el cuerpo (emptyBody).
      (m.text || !m.attachment ? '<div class="contents"><div class="body"><span class="body-text">' + esc(m.text) + '</span></div></div>' : '') +
      (m.attachment ? '<div class="attachments-preview"><div class="attachment-image"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div></div>' : '') +
      '<a class="date-case">' + hhmm(m.sentAt) + '</a></div></div>'
    ).join('');
  }

  function render() { renderBar(); renderMain(); }

  function renderQueue() {
    const b = document.querySelector('span[ng-if*="attachmentsQueue.length"]');
    if (!b) return;
    b.textContent = '(' + queue.length + ')';
    b.hidden = queue.length === 0;
  }

  async function select(id) {
    selected = id;
    queue = [];
    const c = cases.find((x) => x.id === id);
    if (c) c.unread = 0;
    if (SERVER) await api('/services/messaging/markasread?id=' + encodeURIComponent(id) + '&agentId=1', {});
    const got = await fetchCase(id);
    shownCase = got ? got.id : null;
    messages = got ? got.messages : [];
    render();
  }

  /** Refresca solo la lista de mensajes: la caja de texto no se toca (como en la consola real). */
  async function refreshSelected() {
    if (!selected) return;
    const got = await fetchCase(selected);
    if (!got || selected === null) return;
    const before = messages.map((m) => m.id).join();
    const sameCase = got.id === shownCase;
    messages = got.messages;
    shownCase = got.id;
    if (!sameCase || !$('.social-case-conversation-body')) return renderMain();
    if (before !== messages.map((m) => m.id).join())
      $('.social-case-conversation-body').innerHTML = messagesHtml();
  }

  function removeCase(id) {
    cases = cases.filter((c) => c.id !== id);
    local.delete(id);
    if (selected === id) { selected = null; shownCase = null; messages = []; }
    render();
  }

  // ---------- enviar ----------
  /** Como ySocial: token SAS, PUT del archivo al blob y el adjunto en addmessage. */
  async function upload(file) {
    const sas = (await (await api('/services/agents/storage/createsastoken')).json()).Result;
    const name = sas.BaseBlobName + '/' + Math.random().toString(16).slice(2);
    const put = await fetch(sas.BaseUrl + '/' + name + '?' + sas.Token, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': file.type },
      body: file,
    });
    if (!put.ok) throw new Error('blob');
    return { MimeType: file.type, FileName: file.name, FileSize: file.size, File: {}, AzureUploaded: true, AzureBlobName: name };
  }

  async function send() {
    const ta = $('#textareaActAsChat');
    const text = ta.value;
    // Como ySocial (actAsChatAddMessageToCase): sin texto no envía, aunque haya adjuntos (TEXT_REQUIRED).
    if (!text.length || !shownCase) return;
    const files = queue;
    const spinner = $('.social-case-reply-as-chat-send-loading');
    spinner.hidden = false;
    if (SERVER) {
      let attachments;
      try { attachments = await Promise.all(files.map(upload)); } catch { spinner.hidden = true; return; }
      const r = await api('/services/messaging/addmessage', { id: shownCase, messageId: messages.at(-1)?.id, text, closeCase: false, attachments });
      spinner.hidden = true;
      if (!r.ok) return;
      ta.value = '';
      queue = [];
      renderQueue();
      await refreshSelected();
    } else {
      const f = files[0];
      local.get(shownCase).messages.push({ id: String(++seq), sender: 'agent', text, sentAt: new Date().toISOString(), ...(f ? { attachment: { mime: f.type, fileName: f.name, size: f.size } } : {}) });
      ta.value = '';
      queue = [];
      messages = local.get(shownCase).messages;
      renderMain();
    }
  }

  // Pegar (ySocial, controlador principal): si lo pegado trae texto y el destino acepta texto,
  // es texto; si trae un archivo, va a la cola de adjuntos con un aviso.
  document.addEventListener('paste', (event) => {
    const t = event.target;
    const acceptsText = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['button','checkbox','file','hidden','image','radio','reset','submit'].includes((t.type || '').toLowerCase())));
    const items = event.clipboardData ? event.clipboardData.items : [];
    for (const item of items) {
      if (item.kind === 'string' && acceptsText) break;
      if (item.kind === 'file') {
        const blob = item.getAsFile();
        if (!blob || !shownCase) continue;
        queue.push(blob);
        renderQueue();
      }
    }
  });

  // ---------- finalizar ----------
  let finishing = null; // { closeCase }
  async function finishCase(closeCase, tags, observations) {
    const id = shownCase;
    if (SERVER) {
      if (closeCase) {
        const u = await api('/services/cases/update?agentId=1', { id, tags, observations: observations || null, messageId: messages.at(-1)?.id });
        if (!u.ok) return;
      }
      const r = await api('/services/messaging/finish?id=' + encodeURIComponent(id) + '&agentId=1', { closeCase });
      if (!r.ok) return; // el caso sigue asignado
    }
    removeCase(id);
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'textareaActAsChat' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (enterSends()) void send();
    }
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle], a, button');
    if (!t) return;
    const toggle = t.getAttribute('data-toggle');
    if (toggle === 'state') { $('.state-menu').hidden = !$('.state-menu').hidden; return; }
    if (toggle === 'profile') {
      // ng-hide="navigation.removeLogoutButton()": sin «Salir» mientras hay casos asignados.
      $('[ng-click="navigation.signOut()"]').hidden = !!document.querySelector('button.navigation-whatsapp');
      $('.profile-menu').hidden = !$('.profile-menu').hidden;
      return;
    }
    if (toggle === 'finish') { t.parentElement.querySelector('.dropdown-menu').hidden = false; return; }
    const ng = t.getAttribute('ng-click') || '';
    if (ng === 'navigation.switchStates(state)') {
      const name = t.querySelector('.state-name').textContent.trim();
      $('.state-menu').hidden = true;
      const done = () => { $('.agent-state .title').textContent = name; };
      if (!SERVER) return done();
      void api(name === 'Disponible' ? '/services/agents/switchtoavail?id=1' : '/services/agents/switchtopending?id=1&auxReason=7', {}).then((r) => r.ok && done());
      return;
    }
    if (ng === 'navigation.signOut()') {
      // Como ySocial real: con casos asignados no deja salir (ng-hide="removeLogoutButton()").
      if (document.querySelector('button.navigation-whatsapp')) return;
      $('.profile-menu').hidden = true;
      $('[data-modal="signout"]').hidden = false;
      return;
    }
    if (ng === 'signOutConfirm()') {
      $('[data-modal="signout"]').hidden = true;
      if (SERVER) void api('/services/agents/disconnect?id=1', {}).then(() => location.reload());
      return;
    }
    if (ng === 'caseCtrl.handleSendClick($event)') return void (clickSends() && send());
    if (ng.startsWith('caseCtrl.actAsChatInfo.finishMessage(')) {
      finishing = { closeCase: ng.includes('(true)') };
      t.closest('.dropdown-menu').hidden = true;
      $('[data-modal="confirm"]').hidden = false;
      return;
    }
    if (ng === 'confirm()') {
      $('[data-modal="confirm"]').hidden = true;
      if (!finishing) return;
      if (!finishing.closeCase) { finishing = null; return void finishCase(false); }
      const dlg = $('[data-modal="case"]');
      $('[data-case-title]', dlg).textContent = shownCase;
      $('textarea', dlg).value = '';
      $('input[placeholder="Buscar etiqueta..."]', dlg).value = '';
      $('.ivh-treeview', dlg).innerHTML = DATA.tags.map((tag) =>
        '<li class="ivh-treeview-node ivh-treeview-node-leaf"><label><input type="checkbox" class="ivh-treeview-checkbox">' +
        '<span class="ivh-treeview-node-label">' + esc(tag) + '</span></label></li>').join('');
      dlg.hidden = false;
      return;
    }
    if (ng === 'no()') { $('[data-modal="confirm"]').hidden = true; finishing = null; return; }
    if (ng === 'updateCase()') {
      const dlg = $('[data-modal="case"]');
      const tags = [...dlg.querySelectorAll('.ivh-treeview-node')]
        .filter((li) => li.querySelector('input').checked)
        .map((li) => li.textContent.trim());
      if (!tags.length) return; // ySocial exige etiqueta
      dlg.hidden = true;
      finishing = null;
      return void finishCase(true, tags, $('textarea', dlg).value);
    }
    if (ng === 'cancel()') { $('[data-modal="case"]').hidden = true; finishing = null; return; }
  });

  // Buscador de etiquetas.
  document.addEventListener('input', (e) => {
    if (e.target.placeholder !== 'Buscar etiqueta...') return;
    const q = e.target.value.toLowerCase();
    for (const li of document.querySelectorAll('[data-modal="case"] .ivh-treeview-node'))
      li.hidden = !li.textContent.toLowerCase().includes(q);
  });

  // Aviso de caso nuevo con cuenta regresiva.
  let alertTimer = null;
  function showNewCaseAlert() {
    const dlg = $('[data-modal="alert"]');
    const n = $('.button-progress-remaining', dlg);
    let left = 7;
    n.textContent = String(left);
    dlg.hidden = false;
    clearInterval(alertTimer);
    alertTimer = setInterval(() => {
      left--;
      n.textContent = String(left);
      if (left <= 0) { clearInterval(alertTimer); dlg.hidden = true; }
    }, 1000);
  }
  $('[data-modal="alert"] button').addEventListener('click', () => {
    clearInterval(alertTimer);
    $('[data-modal="alert"]').hidden = true;
  });

  render();
  if (selected) void select(selected);

  if (SERVER) {
    // Al cargar, la consola pide el caso completo de cada caso asignado.
    for (const c of cases) if (c.id !== selected) void fetchCase(c.id).catch(() => {});
    // Bandeja: casos asignados (la consola real usa messaging/next y SignalR).
    setInterval(async () => {
      try {
        const r = await api('/services/messaging/assigned');
        const list = (await r.json()).Result;
        const before = JSON.stringify(cases);
        const fresh = list.filter((c) => !known.has(c.id));
        cases = list.map((c) => ({ id: c.id, unread: c.unread, lastId: c.lastId }));
        for (const c of fresh) { known.add(c.id); void fetchCase(c.id); }
        if (fresh.length) showNewCaseAlert();
        if (selected && !cases.some((c) => c.id === selected)) { selected = null; shownCase = null; messages = []; renderMain(); }
        if (before !== JSON.stringify(cases)) { renderBar(); if (!shownCase) renderMain(); }
      } catch {}
    }, 500);
    setInterval(() => void refreshSelected().catch(() => {}), 1000);
    setInterval(() => void api('/services/agents/keepalive', {}).catch(() => {}), 1000);

    // Tiempo real (SignalR, protocolo JSON con separador 0x1E).
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/signalr.net/client/?hub=agents');
    ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + '\\u001e');
    ws.onmessage = (ev) => {
      for (const part of String(ev.data).split('\\u001e')) {
        if (!part) continue;
        const f = JSON.parse(part);
        if (f.type !== 1 || f.target !== 'receive') continue;
        for (const a of f.arguments) {
          if (a.method !== 'NewMessageFromAssignedCase') continue;
          const id = String(a.moreInfo.caseId);
          if (id === selected) void refreshSelected();
          else {
            const c = cases.find((x) => x.id === id);
            if (c) { c.unread = 1; renderBar(); }
            void fetchCase(id);
          }
        }
      }
    };
  }
})();`;
}

/** Datos sintéticos de ejemplo. */
export function sampleChats(): MockChat[] {
  return [
    {
      id: '1001',
      alias: 'Cliente 1001',
      unread: 2,
      messages: [
        {
          id: '501',
          sender: 'system',
          text: 'Voy a comunicarte con uno de nuestros asesores',
          sentAt: '2026-10-05T14:00:00.000Z',
        },
        {
          id: '502',
          sender: 'customer',
          text: 'Hola, quiero información de planes',
          sentAt: '2026-10-05T14:00:05.000Z',
        },
        {
          id: '503',
          sender: 'agent',
          text: '¡Hola! Con gusto te ayudo.',
          sentAt: '2026-10-05T14:00:10.000Z',
        },
        { id: '504', sender: 'customer', text: 'Opción A', sentAt: '2026-10-05T14:00:20.000Z' },
      ],
    },
    {
      id: '1002',
      alias: 'Cliente 1002',
      unread: 0,
      messages: [
        {
          id: '510',
          sender: 'customer',
          text: 'Buenas tardes',
          sentAt: '2026-10-05T14:05:00.000Z',
        },
      ],
    },
  ];
}
