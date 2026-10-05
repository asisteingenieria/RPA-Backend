import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { totp } from '@abaya/crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { inboxHtml, loginHtml, sampleChats, type MockChat, type MockMessage } from './templates.js';

export interface MockAbayaOptions {
  username?: string;
  password?: string;
  /** Si se define, el login exige código TOTP. */
  totpSecret?: string;
  chats?: MockChat[];
}

/**
 * Servidor de Abaya SIMULADO para pruebas E2E locales (F2–F4). Datos sintéticos.
 * Expone controles en proceso para las pruebas: expirar sesiones, inyectar mensajes, etc.
 */
export class MockAbayaServer {
  readonly username: string;
  readonly password: string;
  readonly chats: MockChat[];
  readonly sessions = new Set<string>();
  readonly notes: { chatId: string; note: string }[] = [];
  readonly transfers: { chatId: string; queue: string }[] = [];
  readonly closed: string[] = [];
  loginAttempts = 0;
  /** Si es true, los envíos se aceptan pero no aparecen (para probar UNCERTAIN en F4). */
  dropOutgoing = false;
  /** Si es true, el servidor rechaza las transferencias (prueba de transferencia fallida). */
  failTransfer = false;
  /** Si se define, abrir el chat X muestra el chat Y (para probar el ChatIdentityGuard). */
  readonly misroute = new Map<string, string>();
  /** Mensajes del asesor recibidos por chat (para comprobar chat equivocado y duplicados). */
  readonly agentPosts: { chatId: string; text: string }[] = [];
  private server?: Server;
  private wss?: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private seq = 0;

  constructor(private readonly opts: MockAbayaOptions = {}) {
    this.username = opts.username ?? 'robot-ventas-01';
    this.password = opts.password ?? 'clave-de-prueba';
    this.chats = opts.chats ?? sampleChats();
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== '/ws' || !this.isAuthed(req)) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on('close', () => this.sockets.delete(ws));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return this.url;
  }

  get url(): string {
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.wss?.close();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  // ---------- controles para pruebas ----------

  expireAllSessions() {
    this.sessions.clear();
  }

  addCustomerMessage(chatId: string, text: string): MockMessage {
    const chat = this.chat(chatId) ?? this.assignChat(chatId);
    const m: MockMessage = {
      id: `m-${chatId}-${++this.seq}`,
      sender: 'customer',
      text,
      sentAt: new Date().toISOString(),
    };
    chat.messages.push(m);
    chat.unread++;
    this.broadcast('message.created', { chatId, ...wireMessage(m) });
    return m;
  }

  assignChat(chatId: string, alias = `Cliente ${chatId}`): MockChat {
    const chat: MockChat = { id: chatId, alias, unread: 0, messages: [] };
    this.chats.push(chat);
    this.broadcast('chat.assigned', { chatId });
    return chat;
  }

  chat(chatId: string): MockChat | undefined {
    return this.chats.find((c) => c.id === chatId);
  }

  /** Empuja un evento a todos los navegadores conectados (como el WebSocket de Abaya). */
  broadcast(event: string, data: unknown) {
    const frame = JSON.stringify({ event, data });
    for (const ws of this.sockets) ws.send(frame);
  }

  // ---------- HTTP ----------

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const authed = this.isAuthed(req);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/inbox')) {
      if (!authed) return redirect(res, '/login');
      const requested = url.searchParams.get('chat') ?? undefined;
      const active = requested ? (this.misroute.get(requested) ?? requested) : undefined;
      if (active) {
        const c = this.chat(active);
        if (c) c.unread = 0;
      }
      return html(res, inboxHtml(this.chats, active, 'server'));
    }
    if (req.method === 'GET' && path === '/login') {
      return html(res, loginHtml({ mfa: !!this.opts.totpSecret }));
    }
    if (req.method === 'POST' && path === '/login') {
      this.loginAttempts++;
      const form = new URLSearchParams(await readBody(req));
      const otpOk =
        !this.opts.totpSecret || form.get('otp') === totp(this.opts.totpSecret, new Date());
      if (
        form.get('username') === this.username &&
        form.get('password') === this.password &&
        otpOk
      ) {
        const sid = randomUUID();
        this.sessions.add(sid);
        res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
        return redirect(res, '/inbox');
      }
      return html(
        res,
        loginHtml({ error: 'Usuario o contraseña incorrectos', mfa: !!this.opts.totpSecret }),
        401,
      );
    }
    if (req.method === 'GET' && path === '/logout') {
      const sid = this.sid(req);
      if (sid) this.sessions.delete(sid);
      return redirect(res, '/login');
    }

    if (req.method === 'GET' && path === '/api/ping') {
      return json(res, { ok: authed }, authed ? 200 : 401);
    }

    const m = /^\/api\/chats\/([^/]+)\/(messages|notes|transfer|close)$/.exec(path);
    if (m) {
      if (!authed) return json(res, { error: 'unauthorized' }, 401);
      const chatId = decodeURIComponent(m[1]!);
      const chat = this.chat(chatId);
      if (!chat) return json(res, { error: 'not found' }, 404);
      const action = m[2];
      if (req.method === 'GET' && action === 'messages') {
        return json(res, {
          chatId,
          messages: chat.messages.map(wireMessage),
        });
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, string>;
        if (action === 'messages') {
          this.agentPosts.push({ chatId, text: body.text ?? '' });
          if (!this.dropOutgoing) {
            const out: MockMessage = {
              id: `m-${chatId}-${++this.seq}`,
              sender: 'agent',
              text: body.text ?? '',
              sentAt: new Date().toISOString(),
            };
            chat.messages.push(out);
            this.broadcast('message.created', { chatId, ...wireMessage(out) });
          }
          return json(res, { ok: true }, 201);
        }
        if (action === 'notes') {
          this.notes.push({ chatId, note: body.note ?? '' });
          return json(res, { ok: true }, 201);
        }
        if (action === 'transfer') {
          if (this.failTransfer) return json(res, { error: 'transfer failed' }, 500);
          this.transfers.push({ chatId, queue: body.queue ?? '' });
          this.removeChat(chatId);
          return json(res, { ok: true });
        }
        if (action === 'close') {
          this.closed.push(chatId);
          this.removeChat(chatId);
          return json(res, { ok: true });
        }
      }
    }
    res.statusCode = 404;
    res.end();
  }

  private removeChat(chatId: string) {
    const i = this.chats.findIndex((c) => c.id === chatId);
    if (i >= 0) this.chats.splice(i, 1);
    this.broadcast('chat.removed', { chatId });
  }

  private sid(req: IncomingMessage): string | undefined {
    return /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  }

  private isAuthed(req: IncomingMessage): boolean {
    const sid = this.sid(req);
    return !!sid && this.sessions.has(sid);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function html(res: ServerResponse, body: string, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location });
  res.end();
}

/** Formato de mensaje "en el cable" (XHR y WebSocket) del simulador. */
function wireMessage(m: MockMessage) {
  return { id: m.id, sender: { type: m.sender }, text: m.text, sentAt: m.sentAt };
}
