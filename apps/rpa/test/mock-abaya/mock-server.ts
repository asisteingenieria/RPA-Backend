import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { totp } from '@abaya/crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { customerPageHtml } from './customer-page.js';
import { inboxHtml, loginHtml, sampleChats, type MockChat, type MockMessage } from './templates.js';

export interface MockAbayaOptions {
  username?: string;
  password?: string;
  /** Si se define, el login exige código TOTP. */
  totpSecret?: string;
  chats?: MockChat[];
  /**
   * Como ySocial real (15/10/2026): con una sesión abierta del asesor, otro login responde «ya se
   * encuentra conectado» hasta que esa sesión haga «Salir» (o se expire).
   */
  singleSession?: boolean;
}

/** Id del cliente (PostedBy) en los mensajes simulados. */
const CUSTOMER_ID = 570000000001;

/**
 * Servidor de Abaya SIMULADO (ySocial) para pruebas E2E locales. Datos sintéticos.
 * Mismas rutas que la consola real (`/services/...`, SignalR en `/signalr.net/client/`) y
 * controles en proceso para las pruebas: expirar sesiones, inyectar mensajes, etc.
 */
export class MockAbayaServer {
  readonly username: string;
  readonly password: string;
  readonly chats: MockChat[];
  readonly sessions = new Set<string>();
  /** Observaciones guardadas al cerrar un caso. */
  readonly notes: { chatId: string; note: string }[] = [];
  /** «Finalizar» sin cerrar: el caso pasa a la cola siguiente (venta → backoffice). */
  readonly transfers: { chatId: string }[] = [];
  /** «Finalizar y cerrar el caso». */
  readonly closed: string[] = [];
  /** Etiquetas con que se cerró cada caso. */
  readonly tags: { chatId: string; tags: string[] }[] = [];
  /** Estado del asesor («Login» al entrar). */
  agentState = 'Login';
  loginAttempts = 0;
  /** Si es true, los envíos se aceptan pero no aparecen (para probar UNCERTAIN). */
  dropOutgoing = false;
  /** Si es true, el servidor rechaza «Finalizar» (prueba de transferencia fallida). */
  failTransfer = false;
  /** Si se define, abrir el caso X muestra el caso Y (para probar el ChatIdentityGuard). */
  readonly misroute = new Map<string, string>();
  /** Mensajes del asesor recibidos por caso (para comprobar caso equivocado y duplicados). */
  readonly agentPosts: {
    chatId: string;
    text: string;
    /** D-014 fase 2: adjuntos subidos con el mensaje (bytes recibidos en el blob). */
    attachments?: { mime: string; fileName: string; size: number; bytes: number }[];
  }[] = [];
  /** Archivos subidos al «blob» por nombre (como Azure Blob en ySocial). */
  readonly blobs = new Map<string, Buffer>();
  private server?: Server;
  private wss?: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private seq = 800000;

  constructor(private readonly opts: MockAbayaOptions = {}) {
    this.username = opts.username ?? 'robot-ventas-01';
    this.password = opts.password ?? 'clave-de-prueba';
    this.chats = opts.chats ?? sampleChats();
  }

  /** Casos que salieron de la bandeja (finalizados), para la página del cliente. */
  readonly history: MockChat[] = [];

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== '/signalr.net/client/' || !this.isAuthed(req)) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on('close', () => this.sockets.delete(ws));
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', r));
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

  /**
   * `broadcast: false` simula un corte del tiempo real: el mensaje existe en Abaya (y la
   * bandeja lo marca como no leído) pero el navegador no recibe el aviso.
   */
  addCustomerMessage(
    chatId: string,
    text: string,
    opts: { broadcast?: boolean } = {},
  ): MockMessage {
    const chat = this.chat(chatId) ?? this.assignChat(chatId);
    const m: MockMessage = {
      id: String(++this.seq),
      sender: 'customer',
      text,
      sentAt: new Date().toISOString(),
    };
    chat.messages.push(m);
    chat.unread++;
    if (opts.broadcast !== false)
      this.broadcast('NewMessageFromAssignedCase', {
        caseId: Number(chatId),
        messageId: Number(m.id),
        inAgentQueues: true,
        queueName: 'Servicios Moviles Organica',
      });
    return m;
  }

  assignChat(chatId: string, alias = `Cliente ${chatId}`): MockChat {
    const chat: MockChat = { id: chatId, alias, unread: 0, messages: [] };
    this.chats.push(chat);
    return chat;
  }

  chat(chatId: string): MockChat | undefined {
    return this.chats.find((c) => c.id === chatId);
  }

  /** Empuja un evento a todos los navegadores conectados (como el SignalR de ySocial). */
  broadcast(method: string, moreInfo: unknown) {
    const frame = `${JSON.stringify({
      type: 1,
      target: 'receive',
      arguments: [{ forAgents: true, method, createdAt: new Date().toISOString(), moreInfo }],
    })}\u001e`;
    for (const ws of this.sockets) ws.send(frame);
  }

  // ---------- HTTP ----------

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const authed = this.isAuthed(req);
    const path = url.pathname;
    const post = req.method === 'POST';

    // ---------- página del cliente simulado (solo desarrollo) ----------
    if (path === '/__cliente') return html(res, customerPageHtml());
    if (req.method === 'GET' && path === '/__cliente/api/state') {
      return json(res, {
        chats: this.chats,
        history: this.history,
        notes: this.notes,
        transfers: this.transfers,
        closed: this.closed,
      });
    }
    if (post && path === '/__cliente/api/messages') {
      const body = JSON.parse((await readBody(req)) || '{}') as { chatId?: string; text?: string };
      if (!body.chatId || !/^\d{1,15}$/.test(body.chatId) || !body.text)
        return json(res, { error: 'chatId numérico y text' }, 400);
      return json(res, this.addCustomerMessage(body.chatId, body.text.slice(0, 2000)), 201);
    }

    // ---------- consola del asesor ----------
    if (req.method === 'GET' && (path === '/' || path === '/agent/' || path === '/agent')) {
      if (!authed) return html(res, loginHtml({ mfa: !!this.opts.totpSecret, server: true }));
      return html(res, inboxHtml(this.chats, undefined, 'server', { state: this.agentState }));
    }
    if (post && path === '/services/agents/login') {
      this.loginAttempts++;
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, string>;
      const otpOk = !this.opts.totpSecret || body.otp === totp(this.opts.totpSecret, new Date());
      if (body.username === this.username && body.password === this.password && otpOk) {
        if (this.opts.singleSession && this.sessions.size > 0)
          return json(res, { Success: false }, 409);
        const sid = randomUUID();
        this.sessions.add(sid);
        this.agentState = 'Login';
        res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
        return json(res, { Success: true });
      }
      return json(res, { Success: false }, 401);
    }

    // «Azure Blob» simulado: el navegador sube aquí el adjunto con el token SAS.
    if (req.method === 'PUT' && path.startsWith('/__blob/')) {
      if (url.searchParams.get('sig') !== 'mock') return json(res, { error: 'sas' }, 403);
      this.blobs.set(decodeURIComponent(path.slice('/__blob/'.length)), await readRaw(req));
      res.statusCode = 201;
      return res.end();
    }

    if (!path.startsWith('/services/')) {
      res.statusCode = 404;
      return res.end();
    }
    if (!authed) return json(res, { Success: false, Error: 'unauthorized' }, 401);

    if (post && path === '/services/agents/keepalive') return json(res, { Success: true });
    if (req.method === 'GET' && path === '/services/agents/storage/createsastoken') {
      return json(res, {
        Success: true,
        Result: { Token: 'sig=mock', BaseUrl: `${this.url}/__blob`, BaseBlobName: 'WebAgent/1' },
      });
    }
    if (post && path === '/services/agents/disconnect') {
      const sid = this.sid(req);
      if (sid) this.sessions.delete(sid);
      return json(res, { Success: true });
    }
    if (post && path === '/services/agents/switchtoavail') {
      this.agentState = 'Disponible';
      return json(res, { Success: true });
    }
    if (post && path === '/services/agents/switchtopending') {
      this.agentState = 'Trabajando (Pend. Aux.)';
      return json(res, { Success: true });
    }

    // Bandeja (ruta del simulador: la consola real usa messaging/next + SignalR).
    if (req.method === 'GET' && path === '/services/messaging/assigned') {
      return json(res, {
        Success: true,
        Result: this.chats.map((c) => ({
          id: c.id,
          unread: c.unread,
          lastId: c.messages.at(-1)?.id ?? c.id,
        })),
      });
    }

    const id = url.searchParams.get('id') ?? '';
    if (req.method === 'GET' && path === '/services/messaging/case') {
      const chat = this.chat(this.misroute.get(id) ?? id);
      if (!chat) return json(res, { Success: false }, 404);
      return json(res, yCase(chat));
    }
    if (post && path === '/services/messaging/markasread') {
      const chat = this.chat(this.misroute.get(id) ?? id);
      if (chat) chat.unread = 0;
      return json(res, { Success: true });
    }
    if (post && path === '/services/messaging/addmessage') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        id?: string;
        text?: string;
        attachments?: {
          MimeType?: string;
          FileName?: string;
          FileSize?: number;
          AzureBlobName?: string;
        }[];
      };
      const chatId = String(body.id ?? '');
      const chat = this.chat(chatId);
      if (!chat) return json(res, { Success: false }, 404);
      const attachments = (body.attachments ?? []).map((a) => ({
        mime: a.MimeType ?? '',
        fileName: a.FileName ?? '',
        size: a.FileSize ?? 0,
        bytes: this.blobs.get(a.AzureBlobName ?? '')?.length ?? 0,
      }));
      if (attachments.some((a) => !a.bytes)) return json(res, { Success: false }, 400);
      this.agentPosts.push({
        chatId,
        text: body.text ?? '',
        ...(attachments.length ? { attachments } : {}),
      });
      const first = attachments[0];
      const out: MockMessage = {
        id: String(++this.seq),
        sender: 'agent',
        text: body.text ?? '',
        sentAt: new Date().toISOString(),
        ...(first
          ? { attachment: { mime: first.mime, fileName: first.fileName, size: first.size } }
          : {}),
      };
      if (!this.dropOutgoing) {
        chat.messages.push(out);
        this.broadcast('WhatsappMessageStatusChange', {
          caseId: Number(chatId),
          messageId: Number(out.id),
          parameters: { MessageType: '1', Sent: 'True' },
        });
      }
      return json(res, { Success: true, Result: Number(out.id) });
    }
    if (post && path === '/services/cases/update') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        id?: string;
        tags?: string[];
        observations?: string | null;
      };
      const chatId = String(body.id ?? '');
      this.tags.push({ chatId, tags: body.tags ?? [] });
      if (body.observations) this.notes.push({ chatId, note: body.observations });
      return json(res, { Success: true });
    }
    if (post && path === '/services/messaging/finish') {
      const body = JSON.parse((await readBody(req)) || '{}') as { closeCase?: boolean };
      if (!this.chat(id)) return json(res, { Success: false }, 404);
      if (body.closeCase) this.closed.push(id);
      else {
        if (this.failTransfer) return json(res, { Success: false }, 500);
        this.transfers.push({ chatId: id });
      }
      this.removeChat(id);
      return json(res, { Success: true });
    }

    res.statusCode = 404;
    res.end();
  }

  private removeChat(chatId: string) {
    const i = this.chats.findIndex((c) => c.id === chatId);
    if (i >= 0) this.history.push(...this.chats.splice(i, 1));
  }

  private sid(req: IncomingMessage): string | undefined {
    return /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  }

  private isAuthed(req: IncomingMessage): boolean {
    const sid = this.sid(req);
    return !!sid && this.sessions.has(sid);
  }
}

/** `GET /services/messaging/case` con la forma de ySocial (campos que lee el robot y algunos más). */
function yCase(chat: MockChat) {
  return {
    Success: true,
    Result: {
      Case: {
        ID: Number(chat.id),
        IDStr: chat.id,
        Status: 1,
        Queue: { ID: 147, Name: 'Servicios Moviles Organica' },
        TotalMessages: chat.messages.length,
        Messages: chat.messages.map((m) => ({
          ID: Number(m.id),
          IDStr: m.id,
          PostedBy:
            m.sender === 'customer'
              ? { ID: CUSTOMER_ID, IDStr: String(CUSTOMER_ID), SocialServiceType: 16 }
              : null,
          Incoming: true,
          Body: m.text,
          Date: m.sentAt,
          IsReply: m.sender !== 'customer',
          ReplySource: m.sender === 'agent' ? 3 : m.sender === 'system' ? 10 : null,
          HasAttach: !!m.attachment,
          Attachments: m.attachment
            ? [
                {
                  MimeType: m.attachment.mime,
                  FileName: m.attachment.fileName,
                  FileSize: m.attachment.size,
                },
              ]
            : null,
          IsEvent: false,
          Parameters: { MessageType: '1' },
        })),
      },
    },
  };
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
