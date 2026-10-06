/**
 * Página del "cliente simulado" (solo desarrollo): permite escribir como si fuera el cliente
 * de WhatsApp y ver en vivo lo que responde el robot. Vive en el servidor simulado de Abaya.
 */
export function customerPageHtml(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cliente simulado · Abaya (desarrollo)</title>
<style>
  :root { --bg:#eae6df; --me:#d9fdd3; --bot:#fff; --text:#111b21; --muted:#667781; --accent:#008069; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background:#f0f2f5; color:var(--text); }
  .wrap { max-width: 720px; margin: 0 auto; height: 100vh; display:flex; flex-direction:column; }
  header { background: var(--accent); color:#fff; padding: 12px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  header strong { flex:1; }
  header select, header input, header button { font:inherit; padding:6px 10px; border-radius:6px; border:0; }
  .warn { background:#fff3cd; color:#664d03; padding:6px 16px; font-size:13px; }
  #chat { flex:1; overflow-y:auto; background:var(--bg); padding:16px; display:flex; flex-direction:column; gap:6px; }
  .msg { max-width: 80%; padding:8px 10px; border-radius:8px; white-space: pre-wrap; box-shadow: 0 1px 1px rgba(0,0,0,.1); }
  .customer { align-self:flex-end; background:var(--me); }
  .agent { align-self:flex-start; background:var(--bot); }
  .system { align-self:center; background:#fff8c4; color:var(--muted); font-size:12px; }
  .time { display:block; font-size:11px; color:var(--muted); text-align:right; margin-top:2px; }
  form { display:flex; gap:8px; padding:10px; background:#f0f2f5; }
  form input { flex:1; padding:10px 14px; border-radius:20px; border:1px solid #ddd; font:inherit; }
  form button { background:var(--accent); color:#fff; border:0; border-radius:20px; padding:0 18px; font:inherit; cursor:pointer; }
  .state { padding:6px 16px; font-size:13px; color:var(--muted); background:#fff; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <strong>📱 Cliente simulado</strong>
    <label>Chat <select id="chats"></select></label>
    <button id="nuevo" type="button">Nuevo cliente</button>
  </header>
  <div class="warn">Entorno de desarrollo: Abaya y los planes son SIMULADOS. No escribas datos reales.</div>
  <div class="state" id="state"></div>
  <div id="chat" aria-live="polite"></div>
  <form id="f"><input id="t" placeholder="Escribe como cliente…" autocomplete="off" autofocus><button>Enviar</button></form>
</div>
<script>
  const $ = (s) => document.querySelector(s);
  let current = null;
  let known = [];
  const esc = (s) => s.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

  async function load() {
    const r = await fetch('/__cliente/api/state');
    const st = await r.json();
    const ids = st.chats.map((c) => c.id);
    if (ids.join() !== known.join()) {
      known = ids;
      $('#chats').innerHTML = ids.map((id) => '<option>' + esc(id) + '</option>').join('');
    }
    if (!current && ids.length) current = ids[ids.length - 1];
    if (current) $('#chats').value = current;
    const chat = st.chats.find((c) => c.id === current) || st.history.find((c) => c.id === current);
    const ended = st.transfers.find((t) => t.chatId === current) || st.closed.includes(current);
    const note = st.notes.find((n) => n.chatId === current);
    $('#state').textContent = !current ? 'Crea un cliente para empezar.'
      : ended ? (st.transfers.find((t) => t.chatId === current) ? '✅ Chat transferido a ' + st.transfers.find((t) => t.chatId === current).queue + (note ? ' (con nota interna)' : '') : '🔒 Chat cerrado')
      : 'Chat ' + current + ' asignado al robot';
    if (!chat) { $('#chat').innerHTML = ''; return; }
    const atBottom = $('#chat').scrollHeight - $('#chat').scrollTop - $('#chat').clientHeight < 40;
    $('#chat').innerHTML = chat.messages.map((m) =>
      '<div class="msg ' + m.sender + '">' + esc(m.text) + '<span class="time">' + hhmm(m.sentAt) + '</span></div>'
    ).join('');
    if (atBottom) $('#chat').scrollTop = $('#chat').scrollHeight;
  }

  $('#chats').onchange = (e) => { current = e.target.value; load(); };
  $('#nuevo').onclick = () => { current = 'CH-' + Math.floor(1000 + Math.random() * 9000); $('#t').focus(); load(); };
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#t').value.trim();
    if (!text) return;
    if (!current) current = 'CH-' + Math.floor(1000 + Math.random() * 9000);
    $('#t').value = '';
    await fetch('/__cliente/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: current, text }) });
    load();
  };
  load();
  setInterval(load, 1000);
</script>
</body>
</html>`;
}
