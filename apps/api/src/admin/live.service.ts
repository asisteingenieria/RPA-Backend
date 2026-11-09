import type { PrismaClient } from '@abaya/db';
import type { LiveBus, RobotActivity } from '@abaya/robot-store';
import { robotStatus, type RobotStatus } from '../robots/robots.service.js';
import { OPEN_STATUSES, type ConversationsService } from './conversations.service.js';

/**
 * Monitor en vivo (D-032): qué hace cada robot ahora y sus chats, para los ADMIN. Igual que
 * Trazabilidad, el contenido se descifra solo para la respuesta y nunca va a los logs (regla 6).
 * El tablero se arma una sola vez por intervalo para todos los que miran.
 */

/** Chats cerrados que se siguen mostrando un rato en la tarjeta del robot. */
const RECENT_CLOSED_MS = 10 * 60_000;
const RECENT_CLOSED_MAX = 5;
const PREVIEW_CHARS = 140;
/** Una apertura repetida del tablero por el mismo usuario en esta ventana no se vuelve a auditar. */
const VIEW_AUDIT_WINDOW_MS = 10 * 60_000;
export const BOARD_EVERY_MS = 2_000;

type Delivery = 'VERIFIED' | 'UNCERTAIN' | 'FAILED' | 'PENDING';
const PROCESSES = ['PORTABILIDAD', 'MIGRACION', 'LINEA_NUEVA'];

export interface LiveChatCard {
  id: string;
  abayaChatId: string;
  customerName: string | null;
  stage: string;
  status: string;
  process: string | null;
  closed: boolean;
  createdAt: string;
  updatedAt: string;
  /** De quién es el turno según el último mensaje (null = sin mensajes). */
  turn: 'ROBOT' | 'CLIENTE' | null;
  lastMessage: {
    from: 'bot' | 'client';
    text: string;
    at: string;
    delivery?: Delivery;
    image?: boolean;
    audio?: boolean;
  } | null;
  pendingSends: number;
  uncertainSends: number;
}

export interface LiveRobot {
  robotUser: string;
  status: RobotStatus;
  sessionStatus: string | null;
  paused: boolean;
  host: string | null;
  activity: RobotActivity | null;
  chats: LiveChatCard[];
}

export interface LiveBoard {
  generatedAt: string;
  robots: LiveRobot[];
}

const delivery = (status: string | null): Delivery =>
  status === 'SENT_VERIFIED'
    ? 'VERIFIED'
    : status === 'UNCERTAIN'
      ? 'UNCERTAIN'
      : status === 'FAILED'
        ? 'FAILED'
        : 'PENDING';

const preview = (t: string) =>
  t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : t;

interface LastMessageRow {
  id: string;
  conversationId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  status: string | null;
  occurredAt: Date;
  sentAt: Date | null;
  fingerprint: string | null;
  idempotencyKey: string | null;
  bodyEncrypted: Uint8Array;
  mediaKind: string | null;
  imageId: string | null;
}

export class LiveService {
  private readonly boardListeners = new Set<(b: LiveBoard) => void>();
  private boardTimer?: NodeJS.Timeout;
  private lastBoard?: { json: string; board: LiveBoard };

  constructor(
    private readonly prisma: PrismaClient,
    private readonly conversations: ConversationsService,
    private readonly bus: LiveBus,
    private readonly now: () => Date = () => new Date(),
    private readonly boardEveryMs = BOARD_EVERY_MS,
  ) {}

  // ---------------------------------------------------------------- tablero

  async board(): Promise<LiveBoard> {
    const now = this.now();
    const since = new Date(now.getTime() - RECENT_CLOSED_MS);
    const [robots, sessions, open, closed] = await Promise.all([
      this.prisma.robot.findMany({
        where: { enabled: true },
        select: {
          robotUser: true,
          enabled: true,
          state: true,
          lastSeenAt: true,
          paused: true,
          host: true,
        },
      }),
      this.prisma.rpaSession.findMany({ select: { robotUser: true, status: true } }),
      this.prisma.conversation.findMany({
        where: { status: { in: [...OPEN_STATUSES] } },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
      this.prisma.conversation.findMany({
        where: { status: { notIn: [...OPEN_STATUSES] }, updatedAt: { gte: since } },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    ]);
    const convs = [...open, ...closed];
    const ids = convs.map((c) => c.id);

    const [last, pending] = await Promise.all([
      ids.length
        ? this.prisma.$queryRaw<LastMessageRow[]>`
            SELECT DISTINCT ON ("conversationId")
              id, "conversationId", direction::text AS direction, status::text AS status,
              "occurredAt", "sentAt", fingerprint, "idempotencyKey", "bodyEncrypted",
              "mediaKind"::text AS "mediaKind", "imageId"
            FROM "Message"
            WHERE "conversationId" = ANY(${ids})
            ORDER BY "conversationId", "occurredAt" DESC, "createdAt" DESC`
        : Promise.resolve([] as LastMessageRow[]),
      ids.length
        ? this.prisma.message.groupBy({
            by: ['conversationId', 'status'],
            where: {
              conversationId: { in: ids },
              direction: 'OUTBOUND',
              status: { in: ['PENDING', 'SENDING', 'UNCERTAIN'] },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const lastBy = new Map(last.map((m) => [m.conversationId, m]));
    const counts = new Map<string, { pending: number; uncertain: number }>();
    for (const g of pending) {
      const c = counts.get(g.conversationId) ?? { pending: 0, uncertain: 0 };
      if (g.status === 'UNCERTAIN') c.uncertain += g._count._all;
      else c.pending += g._count._all;
      counts.set(g.conversationId, c);
    }

    const sessionBy = new Map(sessions.map((s) => [s.robotUser, s.status]));
    const robotBy = new Map(robots.map((r) => [r.robotUser, r]));
    // Robots registrados y, en modo directo (desarrollo), los que solo tienen sesión o chats.
    const names = [
      ...new Set([
        ...robots.map((r) => r.robotUser),
        ...sessions.map((s) => s.robotUser),
        ...open.map((c) => c.robotUser),
      ]),
    ].sort();
    const activities = await this.bus.activities(names).catch(() => new Map());

    const cards = new Map<string, LiveChatCard[]>();
    for (const c of convs) {
      const isClosed = !OPEN_STATUSES.includes(c.status);
      const list = cards.get(c.robotUser) ?? [];
      if (isClosed && list.filter((x) => x.closed).length >= RECENT_CLOSED_MAX) continue;
      const profile = this.conversations.profile(c.id, c.profileEncrypted);
      const m = lastBy.get(c.id);
      const n = counts.get(c.id);
      list.push({
        id: c.id,
        abayaChatId: c.abayaChatId,
        customerName: profile.name?.trim() || null,
        stage: c.stage,
        status: c.status,
        process: PROCESSES.includes(profile.process ?? '') ? profile.process! : null,
        closed: isClosed,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        turn: m ? (m.direction === 'INBOUND' ? 'ROBOT' : 'CLIENTE') : null,
        lastMessage: m
          ? {
              from: m.direction === 'OUTBOUND' ? 'bot' : 'client',
              text: preview(this.conversations.body(m) ?? ''),
              at: (m.direction === 'OUTBOUND'
                ? (m.sentAt ?? m.occurredAt)
                : m.occurredAt
              ).toISOString(),
              ...(m.direction === 'OUTBOUND' ? { delivery: delivery(m.status) } : {}),
              ...(m.imageId ? { image: true } : {}),
              ...(m.mediaKind === 'AUDIO' ? { audio: true } : {}),
            }
          : null,
        pendingSends: n?.pending ?? 0,
        uncertainSends: n?.uncertain ?? 0,
      });
      cards.set(c.robotUser, list);
    }

    return {
      generatedAt: now.toISOString(),
      robots: names.map((robotUser) => {
        const r = robotBy.get(robotUser) ?? null;
        const sessionStatus = sessionBy.get(robotUser) ?? null;
        return {
          robotUser,
          status: robotStatus(r, sessionStatus ?? undefined, now),
          sessionStatus,
          paused: r?.paused ?? false,
          host: r?.host ?? null,
          activity: activities.get(robotUser) ?? null,
          // Abiertos primero (los más antiguos arriba), después los recién cerrados.
          chats: (cards.get(robotUser) ?? []).sort((a, b) => Number(a.closed) - Number(b.closed)),
        };
      }),
    };
  }

  /**
   * Suscripción al tablero: una sola consulta por intervalo para todos los que miran; a cada uno
   * le llega el tablero al suscribirse y después solo cuando cambia.
   */
  subscribeBoard(cb: (b: LiveBoard) => void): () => void {
    this.boardListeners.add(cb);
    if (this.lastBoard) cb(this.lastBoard.board);
    if (!this.boardTimer) {
      const tick = async () => {
        try {
          const board = await this.board();
          const json = JSON.stringify({ ...board, generatedAt: undefined });
          if (json !== this.lastBoard?.json) {
            this.lastBoard = { json, board };
            for (const l of this.boardListeners) l(board);
          }
        } catch {
          // Base no disponible: se reintenta en el próximo intervalo; el panel ve el último.
        }
        if (this.boardListeners.size)
          this.boardTimer = setTimeout(() => void tick(), this.boardEveryMs);
        else this.boardTimer = undefined;
      };
      this.boardTimer = setTimeout(() => void tick(), 0);
    }
    return () => {
      this.boardListeners.delete(cb);
      if (!this.boardListeners.size) {
        clearTimeout(this.boardTimer);
        this.boardTimer = undefined;
        this.lastBoard = undefined;
      }
    };
  }

  // ---------------------------------------------------------------- un chat

  /** Mensajes de un chat en vivo (sin audio, sin bytes de imágenes). null si no existe. */
  async chat(ref: string) {
    const c =
      (await this.prisma.conversation.findUnique({ where: { id: ref } })) ??
      (await this.prisma.conversation.findUnique({ where: { abayaChatId: ref } }));
    if (!c) return null;
    const messages = await this.prisma.message.findMany({
      where: { conversationId: c.id },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      omit: { mediaEncrypted: true },
    });
    const imageIds = [...new Set(messages.flatMap((m) => (m.imageId ? [m.imageId] : [])))];
    const images = new Map(
      (imageIds.length
        ? await this.prisma.versionImage.findMany({
            where: { id: { in: imageIds } },
            select: {
              id: true,
              sourceName: true,
              version: { select: { brainId: true, version: true } },
            },
          })
        : []
      ).map((i) => [
        i.id,
        {
          id: i.id,
          sourceName: i.sourceName,
          brainId: i.version.brainId,
          version: i.version.version,
        },
      ]),
    );
    const profile = this.conversations.profile(c.id, c.profileEncrypted);
    return {
      id: c.id,
      abayaChatId: c.abayaChatId,
      robotUser: c.robotUser,
      customerName: profile.name?.trim() || null,
      currentOperator: profile.currentOperator?.trim() || null,
      declaredUse: profile.usage?.trim() || null,
      process: PROCESSES.includes(profile.process ?? '') ? profile.process! : null,
      stage: c.stage,
      status: c.status,
      closed: !OPEN_STATUSES.includes(c.status),
      closeTag: c.closeTag,
      // D-035: sentimiento (solo medición).
      sentiment: c.sentiment,
      sentimentWorst: c.sentimentWorst,
      createdAt: c.createdAt.toISOString(),
      contentPurged: !!c.contentPurgedAt,
      // Mismo formato que el detalle de Trazabilidad (el panel usa el mismo chat).
      messages: messages.map((m) => {
        const bot = m.direction === 'OUTBOUND';
        return {
          id: m.id,
          from: bot ? ('bot' as const) : ('client' as const),
          text: this.conversations.body(m) ?? '',
          sentAt: (bot ? (m.sentAt ?? m.occurredAt) : m.occurredAt).toISOString(),
          ...(bot
            ? {
                delivery: { status: delivery(m.status), attempts: Math.max(1, m.attempts) },
                responseMs:
                  m.respondsToAt && m.sentAt
                    ? Math.max(0, m.sentAt.getTime() - m.respondsToAt.getTime())
                    : null,
              }
            : {}),
          ...(m.imageId ? { image: images.get(m.imageId) ?? null } : {}),
          ...(m.mediaKind === 'AUDIO'
            ? {
                media: {
                  kind: 'AUDIO' as const,
                  durationSec: m.mediaDurationSec,
                  transcriptStatus: m.transcriptStatus ?? 'FAILED',
                  transcriptMs: m.transcriptMs,
                },
              }
            : {}),
        };
      }),
    };
  }

  // ---------------------------------------------------------------- pantalla y auditoría

  async robotExists(robotUser: string): Promise<boolean> {
    if (await this.prisma.robot.findUnique({ where: { robotUser }, select: { robotUser: true } })) {
      return true;
    }
    // Modo directo (desarrollo): el robot solo tiene sesión.
    return !!(await this.prisma.rpaSession.findUnique({
      where: { robotUser },
      select: { id: true },
    }));
  }

  async auditBoardView(actor: string) {
    const since = new Date(this.now().getTime() - VIEW_AUDIT_WINDOW_MS);
    const recent = await this.prisma.adminAuditLog.findFirst({
      where: { actor, action: 'LIVE_VIEWED', createdAt: { gte: since } },
      select: { id: true },
    });
    if (!recent) await this.audit(actor, 'LIVE_VIEWED', null);
  }

  async auditChatView(actor: string, chat: { id: string; abayaChatId: string }) {
    await this.conversations.auditView(actor, chat.abayaChatId, chat.id);
  }

  async auditScreen(actor: string, robotUser: string, seconds?: number) {
    await this.audit(
      actor,
      seconds === undefined ? 'SCREEN_VIEWED' : 'SCREEN_VIEW_ENDED',
      robotUser,
      seconds === undefined ? undefined : { seconds },
    );
  }

  private async audit(actor: string, action: string, target: string | null, detail?: object) {
    await this.prisma.adminAuditLog.create({
      data: { actor: actor.slice(0, 60), action, target, ...(detail ? { detail } : {}) },
    });
  }

  close() {
    this.boardListeners.clear();
    clearTimeout(this.boardTimer);
    this.boardTimer = undefined;
  }
}
