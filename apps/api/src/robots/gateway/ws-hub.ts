import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PrismaClient } from '@abaya/db';
import { KILL_SWITCH_KEY, robotPauseKey, type CloseJob, type TransferJob } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import {
  GATEWAY_PATH,
  RobotQueueConsumers,
  WS_CLOSE_NOT_OWNER,
  WS_CLOSE_REVOKED,
  robotFrameSchema,
  type HandoffDecision,
  type JobKind,
  type RobotQueueHandlers,
  type ServerFrame,
} from '@abaya/robot-store';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FlagStore } from '../../admin/flags.js';
import type { ReleaseService } from '../release.service.js';
import type { RobotsService } from '../robots.service.js';

const PING_MS = 15_000;
const FLAGS_MS = 1_000;
const REVALIDATE_MS = 15_000;
/** Una tarea que no responde en este tiempo se da por fallida (la cola decide reintentar). */
export const JOB_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class RobotConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly consumers: { close(): Promise<void> };
  private readonly timers: NodeJS.Timeout[] = [];
  private flags = '';
  private alive = true;
  closed = false;

  constructor(
    readonly robotUser: string,
    private readonly version: number,
    private readonly ws: WebSocket,
    private readonly d: HubDeps,
    private readonly onClosed: (c: RobotConnection) => void,
  ) {
    const handlers: RobotQueueHandlers = {
      send: async (messageId) => (await this.call('send', { messageId })) as string,
      transfer: async (job: TransferJob, retries) =>
        (await this.call('transfer', job, retries)) as HandoffDecision,
      close: async (job: CloseJob) => (await this.call('close', job)) as HandoffDecision,
    };
    this.consumers = d.consumers
      ? d.consumers(robotUser, handlers)
      : new RobotQueueConsumers(d.redisUrl, robotUser, handlers, d.logger);
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('pong', () => (this.alive = true));
    ws.on('close', () => void this.shutdown());
    ws.on('error', () => void this.shutdown());
    this.timers.push(
      setInterval(() => {
        if (!this.alive) return this.ws.terminate();
        this.alive = false;
        this.ws.ping();
      }, PING_MS),
      setInterval(() => void this.pushFlags(), FLAGS_MS),
      setInterval(() => void this.revalidate(), d.revalidateMs ?? REVALIDATE_MS),
    );
    void this.pushFlags();
  }

  /** Envía una tarea al equipo y espera su resultado. */
  call(kind: JobKind, data: unknown, retries?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('robot desconectado'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('el robot no respondió a tiempo'));
      }, this.d.jobTimeoutMs ?? JOB_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: 'job', id, kind, data, ...(retries !== undefined ? { retries } : {}) });
    });
  }

  close(code: number, reason: string) {
    this.ws.close(code, reason);
    void this.shutdown();
  }

  private send(frame: ServerFrame) {
    if (!this.closed) this.ws.send(JSON.stringify(frame));
  }

  private onMessage(raw: string) {
    let parsed;
    try {
      parsed = robotFrameSchema.safeParse(JSON.parse(raw));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const f = parsed.data;
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    clearTimeout(p.timer);
    if (f.ok) p.resolve(f.value);
    else p.reject(new Error(f.error.slice(0, 200)));
  }

  /** Kill switch global y pausa de ESTE robot: se empujan al cambiar (y al conectar). */
  private async pushFlags() {
    try {
      const [ks, pause, robot] = await Promise.all([
        this.d.flags.get(KILL_SWITCH_KEY),
        this.d.flags.get(robotPauseKey(this.robotUser)),
        this.d.prisma.robot.findUnique({
          where: { robotUser: this.robotUser },
          select: { updateRequested: true, version: true },
        }),
      ]);
      const target = this.d.release?.installable() ?? null;
      const update = robot?.updateRequested && target && robot.version !== target ? target : null;
      const frame = {
        t: 'flags' as const,
        killSwitch: ks === '1',
        paused: pause === '1',
        update,
      };
      const key = JSON.stringify(frame);
      if (key !== this.flags) {
        this.flags = key;
        this.send(frame);
      }
    } catch {
      // Sin Redis no se puede afirmar que el robot pueda actuar: se detiene (falla cerrado).
      const frame = { t: 'flags' as const, killSwitch: true, paused: false };
      this.flags = JSON.stringify(frame);
      this.send(frame);
    }
  }

  /** Deshabilitado o revocado desde el panel: se corta la conexión. */
  private async revalidate() {
    if (!(await this.d.robots.isAccessValid(this.robotUser, this.version))) {
      this.close(WS_CLOSE_REVOKED, 'revocado');
    }
  }

  private async shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.timers.forEach(clearInterval);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('robot desconectado'));
    }
    this.pending.clear();
    await this.consumers.close().catch(() => undefined);
    this.onClosed(this);
  }
}

export interface HubDeps {
  robots: RobotsService;
  prisma: PrismaClient;
  flags: FlagStore;
  redisUrl: string;
  logger: Logger;
  jobTimeoutMs?: number;
  /** Versión publicada (v1.7): se avisa a los robots con actualización pedida. */
  release?: ReleaseService;
  /** Cada cuánto se revisa si el robot fue deshabilitado o revocado. */
  revalidateMs?: number;
  /** Pruebas: consumidores de colas sin Redis. */
  consumers?: (robotUser: string, h: RobotQueueHandlers) => { close(): Promise<void> };
}

/**
 * WebSocket de la pasarela (v1.6): el servidor empuja a cada robot hijo sus tareas (desde sus
 * colas de BullMQ, con las mismas reglas de reintento) y el estado del kill switch/pausa.
 * Solo la instancia dueña del robot (según la presencia) puede conectarse.
 */
export class RobotWsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly conns = new Map<string, RobotConnection>();
  private readonly path = `/${GATEWAY_PATH}/ws`;

  constructor(
    server: Server,
    private readonly d: HubDeps,
  ) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== this.path) return;
      void this.upgrade(req, socket, head, url.searchParams.get('instanceId'));
    });
  }

  connected(robotUser: string): boolean {
    return this.conns.has(robotUser);
  }

  async close() {
    for (const c of [...this.conns.values()]) c.close(1001, 'servidor apagándose');
    this.wss.close();
  }

  private async upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    instanceId: string | null,
  ) {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    let access: { robotUser: string; version: number };
    try {
      access = await this.d.robots.verifyAccess(req.headers.authorization);
    } catch {
      return reject(401, 'Unauthorized');
    }
    // Solo la instancia que tiene reclamado el robot (presencia) recibe sus tareas.
    const robot = await this.d.prisma.robot.findUnique({
      where: { robotUser: access.robotUser },
      select: { instanceId: true, state: true },
    });
    if (!instanceId || robot?.instanceId !== instanceId || robot.state !== 'ONLINE') {
      return reject(409, 'Conflict');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const previous = this.conns.get(access.robotUser);
      previous?.close(WS_CLOSE_NOT_OWNER, 'reemplazada');
      const conn = new RobotConnection(access.robotUser, access.version, ws, this.d, (c) => {
        if (this.conns.get(c.robotUser) === c) this.conns.delete(c.robotUser);
      });
      this.conns.set(access.robotUser, conn);
      this.d.logger.info({ robotUser: access.robotUser }, 'robot conectado a la pasarela');
    });
  }
}
