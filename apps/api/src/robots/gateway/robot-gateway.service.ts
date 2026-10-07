import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FieldCipher } from '@abaya/crypto';
import type { PrismaClient } from '@abaya/db';
import { QUEUES, robotQueue, type AlertPort } from '@abaya/domain';
import {
  BullInboundQueue,
  DirectInboundSink,
  PrismaActionLog,
  PrismaHandoffRepository,
  PrismaInboundRepository,
  PrismaOutboundRepository,
  PrismaPresenceStore,
  PrismaRecoveryRepository,
  PrismaSessionRepository,
  PrismaSweepRepository,
  TRACE_REF_RE,
  rpcParams,
  traceAad,
  type InboundQueue,
  type RpcMethod,
  type RpcParams,
} from '@abaya/robot-store';
import { Queue } from 'bullmq';
import { ServiceError } from '../../admin/errors.js';

/** Tamaño máximo de una traza subida por un robot. */
export const MAX_TRACE_BYTES = 50 * 1024 * 1024;
/** Retención de trazas en el servidor (sección 8). */
const TRACE_RETENTION_DAYS = 7;

type Handler<M extends RpcMethod> = (robotUser: string, p: RpcParams<M>) => Promise<unknown>;

/**
 * Pasarela de robots hijos (v1.6, sección 2.8): cada operación del robot se ejecuta aquí, en el
 * servidor, con la base de datos, Redis y la clave de cifrado que el equipo nunca recibe.
 * Regla de oro: el robot sale SIEMPRE del token; todo dato que nombre una conversación o un
 * mensaje se verifica como propio antes de leerlo o tocarlo.
 */
export class RobotGateway {
  private readonly session: PrismaSessionRepository;
  private readonly actionLog: PrismaActionLog;
  private readonly outbound: PrismaOutboundRepository;
  private readonly handoff: PrismaHandoffRepository;
  private readonly recovery: PrismaRecoveryRepository;
  private readonly presence: PrismaPresenceStore;
  private readonly sweep: PrismaSweepRepository;
  private readonly inboundRepo: PrismaInboundRepository;
  private readonly inboundQueue: InboundQueue;
  private readonly outboundQueues = new Map<string, Queue>();
  private readonly handlers: { [M in RpcMethod]: Handler<M> };

  constructor(
    private readonly d: {
      prisma: PrismaClient;
      cipher: FieldCipher;
      redisUrl: string;
      alerts: AlertPort;
      traceDir: string;
      /** Pruebas: cola de entrantes y reencolado de envíos sin Redis. */
      inboundQueue?: InboundQueue;
      enqueueOutbound?: (
        robotUser: string,
        messageId: string,
        abayaChatId: string,
      ) => Promise<void>;
    },
  ) {
    const { prisma, cipher } = d;
    this.session = new PrismaSessionRepository(prisma);
    this.actionLog = new PrismaActionLog(prisma);
    this.outbound = new PrismaOutboundRepository(prisma, cipher);
    this.handoff = new PrismaHandoffRepository(prisma, cipher);
    this.recovery = new PrismaRecoveryRepository(prisma);
    this.presence = new PrismaPresenceStore(prisma);
    this.sweep = new PrismaSweepRepository(prisma);
    this.inboundRepo = new PrismaInboundRepository(prisma);
    this.inboundQueue = d.inboundQueue ?? new BullInboundQueue(d.redisUrl);
    this.handlers = {
      'session.get': async (r) => this.session.get(r),
      'session.save': async (r, p) =>
        this.session.save({
          robotUser: r,
          status: p.status,
          lastHeartbeat: new Date(p.lastHeartbeat),
          lastLoginAt: p.lastLoginAt ? new Date(p.lastLoginAt) : null,
          consecutiveFails: p.consecutiveFails,
        }),
      'actionLog.append': async (r, p) => {
        if (p.abayaChatId) await this.ownChat(r, p.abayaChatId, true);
        const stored = await this.actionLog.append({
          ...p,
          robotUser: r,
          createdAt: new Date(p.createdAt),
        });
        return { prevHash: stored.prevHash, hash: stored.hash };
      },
      'inbound.chatAssigned': async (r, p) => this.sink(r).chatAssigned(p.abayaChatId),
      'inbound.store': async (r, p) =>
        this.sink(r).store({ ...p, occurredAt: new Date(p.occurredAt) }),
      'outbound.get': async (r, p) => {
        await this.ownMessage(r, p.messageId);
        return this.outbound.get(p.messageId);
      },
      'outbound.setStatus': async (r, p) => {
        await this.ownMessage(r, p.messageId);
        await this.outbound.setStatus(p.messageId, p.status, p.incrementAttempts ?? false);
      },
      'handoff.outboundStatuses': async (r, p) => {
        for (const m of p.messageIds) await this.ownMessage(r, m);
        return this.handoff.outboundStatuses(p.messageIds);
      },
      'handoff.sale': async (r, p) => {
        await this.ownConversation(r, p.conversationId);
        return this.handoff.sale(p.conversationId);
      },
      'handoff.markNoteOk': async (r, p) => {
        await this.ownConversation(r, p.conversationId);
        await this.handoff.markNoteOk(p.conversationId);
      },
      'handoff.markTransferred': async (r, p) => {
        await this.ownConversation(r, p.conversationId);
        await this.handoff.markTransferred(p.conversationId, p.target);
      },
      'handoff.markNeedsReview': async (r, p) => {
        await this.ownConversation(r, p.conversationId);
        await this.handoff.markNeedsReview(p.conversationId);
      },
      'recovery.pendingOutbound': async (r) => this.recovery.pendingOutbound(r),
      'recovery.openConversations': async (r) => this.recovery.openConversations(r),
      'recovery.markNeedsReview': async (r, p) => {
        for (const c of p.conversationIds) await this.ownConversation(r, c);
        await this.recovery.markNeedsReview(p.conversationIds);
      },
      'recovery.enqueueOutbound': async (r, p) => {
        const chat = await this.ownMessage(r, p.messageId);
        if (chat !== p.abayaChatId) throw new ServiceError(403, 'El mensaje no es de ese chat');
        if (this.d.enqueueOutbound) return this.d.enqueueOutbound(r, p.messageId, p.abayaChatId);
        // jobId fijo por mensaje: no se apilan reencolados; el robot es idempotente.
        await this.outboundQueue(r).add(
          'message',
          { messageId: p.messageId, abayaChatId: p.abayaChatId },
          { jobId: `recover-${p.messageId}` },
        );
      },
      'presence.claim': async (r, p) => this.presence.claim({ robotUser: r, ...p }, new Date()),
      'presence.beat': async (r, p) => this.presence.beat(r, p.instanceId, new Date()),
      'presence.release': async (r, p) => this.presence.release(r, p.instanceId, new Date()),
      'sweep.idleChats': async (r, p) => this.sweep.idleChats(r, p.abayaChatIds),
      'update.report': async (r, p) => {
        const finished = ['APPLIED', 'FAILED', 'ROLLED_BACK'].includes(p.status);
        await this.d.prisma.robot.update({
          where: { robotUser: r },
          data: {
            updateStatus: p.status,
            ...(p.version ? { updateVersion: p.version } : {}),
            updateMessage: p.message ?? null,
            updateAt: new Date(),
            // Terminada (bien o mal): no se vuelve a intentar sola; reintentar es decisión humana.
            ...(finished ? { updateRequested: false } : {}),
          },
        });
        if (p.status === 'FAILED' || p.status === 'ROLLED_BACK') {
          await this.d.alerts.raise('ROBOT_UPDATE_FAILED', 'ALTA', {
            robotUser: r,
            status: p.status,
            version: p.version,
          });
        }
      },
      'alerts.raise': async (r, p) =>
        this.d.alerts.raise(p.code, p.severity, { ...(p.detail ?? {}), robotUser: r }),
    };
  }

  /** Ejecuta una operación ya autenticada. Parámetros validados con el esquema del protocolo. */
  async call(robotUser: string, method: RpcMethod, rawParams: unknown): Promise<unknown> {
    const parsed = rpcParams[method].safeParse(rawParams ?? {});
    if (!parsed.success) throw new ServiceError(400, `Parámetros inválidos para ${method}`);
    const handler = this.handlers[method] as Handler<RpcMethod>;
    return (await handler(robotUser, parsed.data as never)) ?? null;
  }

  /** Guarda cifrada una traza de error subida por el robot (retención 7 días). */
  async saveTrace(robotUser: string, ref: string, zip: Buffer): Promise<void> {
    if (!TRACE_REF_RE.test(ref)) throw new ServiceError(400, 'Referencia de traza inválida');
    if (!zip.length || zip.length > MAX_TRACE_BYTES) {
      throw new ServiceError(400, 'Traza vacía o demasiado grande');
    }
    const dir = this.traceDirOf(robotUser);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${ref}.trace.enc`), this.d.cipher.encrypt(zip, traceAad(ref)), {
      mode: 0o600,
    });
  }

  traceDirOf(robotUser: string): string {
    return join(this.d.traceDir, 'robots', robotUser.replace(/[^\w.-]/g, '_'));
  }

  /** Trazas de un robot (más recientes primero), para el panel. */
  async listTraces(robotUser: string) {
    const dir = this.traceDirOf(robotUser);
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
      f.endsWith('.trace.enc'),
    );
    const out: { ref: string; bytes: number; at: Date }[] = [];
    for (const f of files) {
      const st = await stat(join(dir, f)).catch(() => null);
      if (st) out.push({ ref: f.slice(0, -'.trace.enc'.length), bytes: st.size, at: st.mtime });
    }
    return out.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  /** Traza descifrada (zip de Playwright). Quien la pide queda en la auditoría. */
  async readTrace(robotUser: string, ref: string): Promise<Buffer> {
    if (!TRACE_REF_RE.test(ref)) throw new ServiceError(400, 'Referencia de traza inválida');
    const enc = await readFile(join(this.traceDirOf(robotUser), `${ref}.trace.enc`)).catch(
      () => null,
    );
    if (!enc) throw new ServiceError(404, 'Traza no encontrada');
    return this.d.cipher.decrypt(enc, traceAad(ref));
  }

  /** Borra trazas de robots más antiguas que la retención. */
  async cleanupTraces(now = Date.now()): Promise<number> {
    let removed = 0;
    const root = join(this.d.traceDir, 'robots');
    const robots = await readdir(root).catch(() => [] as string[]);
    for (const r of robots) {
      const dir = join(root, r);
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        const st = await stat(join(dir, f)).catch(() => null);
        if (st && now - st.mtimeMs > TRACE_RETENTION_DAYS * 86_400_000) {
          await rm(join(dir, f), { force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  async close() {
    await this.inboundQueue.close();
    await Promise.all([...this.outboundQueues.values()].map((q) => q.close()));
  }

  // ---------- pertenencia: un robot solo toca lo suyo ----------

  private sink(robotUser: string) {
    return new DirectInboundSink({
      robotUser,
      repo: this.inboundRepo,
      queue: this.inboundQueue,
      cipher: this.d.cipher,
    });
  }

  private outboundQueue(robotUser: string): Queue {
    let q = this.outboundQueues.get(robotUser);
    if (!q) {
      q = new Queue(robotQueue(QUEUES.outbound, robotUser), {
        connection: { url: this.d.redisUrl },
      });
      this.outboundQueues.set(robotUser, q);
    }
    return q;
  }

  private async ownConversation(robotUser: string, conversationId: string) {
    const c = await this.d.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { robotUser: true },
    });
    if (!c || c.robotUser !== robotUser) throw new ServiceError(403, 'Conversación ajena');
  }

  /** Devuelve el chat del mensaje si es del robot; si no, 403. */
  private async ownMessage(robotUser: string, messageId: string): Promise<string> {
    const m = await this.d.prisma.message.findUnique({
      where: { id: messageId },
      select: { conversation: { select: { robotUser: true, abayaChatId: true } } },
    });
    if (!m || m.conversation.robotUser !== robotUser) throw new ServiceError(403, 'Mensaje ajeno');
    return m.conversation.abayaChatId;
  }

  /** Un chat que aún no existe se acepta (lo crea el robot al detectarlo); uno ajeno, no. */
  private async ownChat(robotUser: string, abayaChatId: string, allowMissing: boolean) {
    const c = await this.d.prisma.conversation.findUnique({
      where: { abayaChatId },
      select: { robotUser: true },
    });
    if ((!c && !allowMissing) || (c && c.robotUser !== robotUser)) {
      throw new ServiceError(403, 'Chat ajeno');
    }
  }
}
