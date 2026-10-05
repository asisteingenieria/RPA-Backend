/**
 * Markup del Abaya SIMULADO. Supuesto de trabajo mientras no haya acceso al ambiente
 * real (F1): cuando existan fixtures reales sanitizados en fixtures/abaya/, las pruebas de
 * page objects se apuntan a ellos y este simulador se ajusta para imitarlos.
 *
 * Todos los datos son sintéticos.
 */

export type MockSender = 'customer' | 'agent' | 'system';

export interface MockMessage {
  id: string;
  sender: MockSender;
  text: string;
  sentAt: string; // ISO
}

export interface MockChat {
  id: string;
  alias: string;
  unread: number;
  messages: MockMessage[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>${esc(title)}</title>
<style>ol[aria-label="Mensajes"] p { white-space: pre-wrap; }</style></head>
<body>
${body}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

export function loginHtml(opts: { error?: string; mfa?: boolean } = {}): string {
  return layout(
    'Abaya - Iniciar sesión',
    `<main>
  <h1>Abaya</h1>
  <form method="post" action="/login" aria-label="Iniciar sesión">
    <label>Usuario <input name="username" autocomplete="username"></label>
    <label>Contraseña <input name="password" type="password" autocomplete="current-password"></label>
    ${opts.mfa ? '<label>Código de verificación <input name="otp" inputmode="numeric"></label>' : ''}
    <button type="submit">Ingresar</button>
  </form>
  ${opts.error ? `<p role="alert">${esc(opts.error)}</p>` : ''}
</main>`,
  );
}

export function chatListHtml(chats: MockChat[], activeId?: string): string {
  return `<nav aria-label="Chats asignados">
  <ul>
    ${chats
      .map(
        (c) => `<li data-chat-id="${esc(c.id)}">
      <button type="button" aria-current="${c.id === activeId ? 'true' : 'false'}">${esc(c.alias)}</button>
      ${c.unread > 0 ? `<span data-unread="${c.unread}" aria-label="${c.unread} mensajes sin leer">${c.unread}</span>` : ''}
    </li>`,
      )
      .join('\n    ')}
  </ul>
</nav>`;
}

export function messagesHtml(messages: MockMessage[]): string {
  return messages
    .map(
      (m) =>
        `<li data-message-id="${esc(m.id)}" data-sender="${m.sender}" data-timestamp="${esc(m.sentAt)}"><p>${esc(m.text)}</p></li>`,
    )
    .join('\n      ');
}

export function chatPanelHtml(chat: MockChat | undefined): string {
  if (!chat) return '<section aria-label="Conversación"><p>Selecciona un chat</p></section>';
  return `<section aria-label="Conversación" data-chat-id="${esc(chat.id)}">
  <header><h2>Chat ${esc(chat.id)}</h2><p>${esc(chat.alias)}</p></header>
  <ol aria-label="Mensajes">
      ${messagesHtml(chat.messages)}
  </ol>
  <form aria-label="Responder">
    <textarea aria-label="Escribe un mensaje"></textarea>
    <button type="submit">Enviar</button>
  </form>
  <div role="toolbar" aria-label="Acciones del chat">
    <button type="button" data-action="note">Nota interna</button>
    <button type="button" data-action="transfer">Transferir</button>
    <button type="button" data-action="close">Cerrar chat</button>
  </div>
  <dialog aria-label="Nota interna" data-dialog="note">
    <form method="dialog">
      <textarea aria-label="Nota"></textarea>
      <button type="submit" value="save">Guardar nota</button>
    </form>
  </dialog>
  <dialog aria-label="Transferir chat" data-dialog="transfer">
    <form method="dialog">
      <label>Cola
        <select>
          <option value="">Selecciona…</option>
          <option value="backoffice">Backoffice ventas</option>
          <option value="asesores">Asesores humanos</option>
        </select>
      </label>
      <button type="submit" value="transfer">Confirmar transferencia</button>
    </form>
  </dialog>
</section>`;
}

/**
 * Comportamiento del simulador en el navegador.
 * - static: para page.setContent (sin servidor): todo ocurre en el DOM.
 * - server: habla con el servidor simulado (mock-server.ts) y hace polling de mensajes,
 *   lo que genera el tráfico de red que escucha el InboundWatcher.
 */
export function clientScript(mode: 'static' | 'server'): string {
  return `
(() => {
  const MODE = ${JSON.stringify(mode)};
  const $ = (s, r = document) => r.querySelector(s);
  const panel = () => $('section[data-chat-id]');
  const chatId = () => panel()?.getAttribute('data-chat-id');
  const esc = (s) => s.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const api = (path, body) => fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  function appendAgent(text) {
    const ol = $('ol[aria-label="Mensajes"]');
    const li = document.createElement('li');
    li.setAttribute('data-message-id', 'local-' + Date.now());
    li.setAttribute('data-sender', 'agent');
    li.setAttribute('data-timestamp', new Date().toISOString());
    li.innerHTML = '<p>' + esc(text) + '</p>';
    ol.appendChild(li);
  }

  function removeActiveChat() {
    const id = chatId();
    document.querySelector('nav [data-chat-id="' + id + '"]')?.remove();
    panel()?.replaceWith(Object.assign(document.createElement('section'), { ariaLabel: 'Conversación', innerHTML: '<p>Selecciona un chat</p>' }));
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('nav [data-chat-id]');
    if (li) {
      const id = li.getAttribute('data-chat-id');
      if (MODE === 'server') { location.href = '/inbox?chat=' + encodeURIComponent(id); return; }
      document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', 'false'));
      btn.setAttribute('aria-current', 'true');
      return;
    }
    const action = btn.getAttribute('data-action');
    if (action === 'note') $('dialog[data-dialog="note"]').showModal();
    if (action === 'transfer') $('dialog[data-dialog="transfer"]').showModal();
    if (action === 'close') {
      if (MODE === 'server') await api('/api/chats/' + chatId() + '/close', {});
      removeActiveChat();
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (form.getAttribute('aria-label') === 'Responder') {
      e.preventDefault();
      const ta = $('textarea', form);
      const text = ta.value;
      if (!text.trim()) return;
      ta.value = '';
      if (MODE === 'server') {
        const r = await api('/api/chats/' + chatId() + '/messages', { text });
        if (!r.ok) return;
      }
      appendAgent(text);
      return;
    }
    const dlg = form.closest('dialog');
    if (dlg?.dataset.dialog === 'note') {
      const note = $('textarea', form).value;
      if (MODE === 'server') { e.preventDefault(); await api('/api/chats/' + chatId() + '/notes', { note }); dlg.close(); }
      return;
    }
    if (dlg?.dataset.dialog === 'transfer') {
      const queue = $('select', form).value;
      if (!queue) { e.preventDefault(); return; }
      e.preventDefault();
      if (MODE === 'server') await api('/api/chats/' + chatId() + '/transfer', { queue });
      dlg.close();
      removeActiveChat();
    }
  });

  if (MODE === 'server') {
    const render = (msgs) => {
      const ol = $('ol[aria-label="Mensajes"]');
      if (!ol) return;
      ol.innerHTML = msgs.map((m) =>
        '<li data-message-id="' + esc(m.id) + '" data-sender="' + m.sender.type + '" data-timestamp="' + esc(m.sentAt) + '"><p>' + esc(m.text) + '</p></li>'
      ).join('');
    };
    setInterval(async () => {
      const r = await api('/api/ping');
      if (r.status === 401) location.href = '/login';
    }, 1000);
    setInterval(async () => {
      const id = chatId();
      if (!id) return;
      const r = await api('/api/chats/' + encodeURIComponent(id) + '/messages');
      if (r.status === 401) { location.href = '/login'; return; }
      if (r.ok) render((await r.json()).messages);
    }, 1000);
  }
})();`;
}

export function inboxHtml(
  chats: MockChat[],
  activeId?: string,
  mode: 'static' | 'server' = 'static',
): string {
  const active = chats.find((c) => c.id === activeId);
  return layout(
    'Abaya - Bandeja',
    `<header role="banner"><span>Sesión: robot-ventas-01</span><a href="/logout">Salir</a></header>
<div>
${chatListHtml(chats, activeId)}
${chatPanelHtml(active)}
</div>`,
    clientScript(mode),
  );
}

/** Datos sintéticos de ejemplo. */
export function sampleChats(): MockChat[] {
  return [
    {
      id: 'CH-1001',
      alias: 'Cliente 1001',
      unread: 2,
      messages: [
        {
          id: 'm-1',
          sender: 'system',
          text: 'Chat asignado a robot-ventas-01',
          sentAt: '2026-10-05T14:00:00.000Z',
        },
        {
          id: 'm-2',
          sender: 'customer',
          text: 'Hola, quiero información de planes',
          sentAt: '2026-10-05T14:00:05.000Z',
        },
        {
          id: 'm-3',
          sender: 'agent',
          text: '¡Hola! Con gusto te ayudo.',
          sentAt: '2026-10-05T14:00:10.000Z',
        },
        { id: 'm-4', sender: 'customer', text: 'Opción A', sentAt: '2026-10-05T14:00:20.000Z' },
      ],
    },
    {
      id: 'CH-1002',
      alias: 'Cliente 1002',
      unread: 0,
      messages: [
        {
          id: 'm-10',
          sender: 'customer',
          text: 'Buenas tardes',
          sentAt: '2026-10-05T14:05:00.000Z',
        },
      ],
    },
  ];
}
