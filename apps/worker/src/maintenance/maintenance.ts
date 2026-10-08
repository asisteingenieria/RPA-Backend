import { openChatsByRobot, responseTimeByRobot, utcParam, type PrismaClient } from '@abaya/db';
import type { AlertPort, AlertSeverity } from '@abaya/domain';
import type { Logger } from '@abaya/logger';

const OPEN_STATUSES = ['ACTIVE', 'WAITING_CONSENT'] as const;

/** Conversaciones con mensajes del cliente sin atender (para retomarlas al reiniciar). */
export async function conversationsWithPendingInbound(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.conversation.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      messages: { some: { direction: 'INBOUND', processedAt: null } },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Cierre por inactividad (sección 6.6): sin mensajes del cliente durante `minutes` y sin
 * nada pendiente. El cierre en Abaya lo hace el rpa al consumir el evento.
 */
export async function closeInactive(
  prisma: PrismaClient,
  now: Date,
  minutes: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const candidates = await prisma.conversation.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      messages: { none: { direction: 'INBOUND', processedAt: null } },
      OR: [{ lastInboundAt: { lt: cutoff } }, { lastInboundAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true, abayaChatId: true, robotUser: true },
  });
  let closed = 0;
  for (const c of candidates) {
    await prisma.$transaction(async (tx) => {
      // Condición repetida: si entró un mensaje o cambió el estado mientras tanto, no cerrar.
      const r = await tx.conversation.updateMany({
        where: {
          id: c.id,
          status: { in: [...OPEN_STATUSES] },
          messages: { none: { direction: 'INBOUND', processedAt: null } },
        },
        data: { status: 'CLOSED_INACTIVE' },
      });
      if (r.count === 0) return;
      closed++;
      await tx.outboxEvent.create({
        data: {
          type: 'ConversationClosed',
          payload: {
            conversationId: c.id,
            abayaChatId: c.abayaChatId,
            robotUser: c.robotUser,
            reason: 'INACTIVE',
            afterMessageIds: [],
          },
        },
      });
    });
  }
  return closed;
}

// ---------- retención de conversaciones (D-002) ----------

/** Estados en los que la conversación ya terminó (las abiertas nunca se borran). */
const CLOSED_STATUSES = [
  'TRANSFERRED_BACKOFFICE',
  'CLOSED_NO_SALE',
  'CLOSED_SUPPORT',
  'CLOSED_INACTIVE',
] as const;

/**
 * Borra el CONTENIDO de las conversaciones cerradas hace más de `days` días: mensajes, perfil,
 * resumen de la venta y respuesta del consentimiento. Conserva la conversación (tipificación,
 * etapa, robot, fechas), la venta (plan, transferencia) y los hashes de la cadena, para que las
 * métricas históricas sigan cuadrando. Marca `contentPurgedAt`.
 */
export async function purgeExpiredConversations(
  prisma: PrismaClient,
  now: Date,
  days: number,
  batch = 200,
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  let purged = 0;
  for (;;) {
    const ids = (
      await prisma.conversation.findMany({
        where: {
          status: { in: [...CLOSED_STATUSES] },
          updatedAt: { lt: cutoff },
          contentPurgedAt: null,
        },
        select: { id: true },
        take: batch,
      })
    ).map((c) => c.id);
    if (!ids.length) return purged;
    const empty = new Uint8Array(0);
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { conversationId: { in: ids } } }),
      prisma.sale.updateMany({
        where: { conversationId: { in: ids } },
        data: { summaryEncrypted: empty },
      }),
      prisma.consentEvidence.updateMany({
        where: { conversationId: { in: ids } },
        data: { customerReplyEncrypted: empty },
      }),
      // updatedAt se conserva: es el fin de la conversación (duración en la Trazabilidad).
      prisma.$executeRaw`
        UPDATE "Conversation" SET "profileEncrypted" = NULL, "contentPurgedAt" = ${utcParam(now)}
        WHERE id = ANY(${ids})`,
    ]);
    purged += ids.length;
    if (ids.length < batch) return purged;
  }
}

// ---------- monitor de alertas (sección 11) ----------

export interface CheckResult {
  active: boolean;
  detail?: Record<string, unknown>;
}

export interface AlertCheck {
  code: string;
  severity: AlertSeverity;
  evaluate(now: Date): Promise<CheckResult>;
}

/**
 * Evalúa las condiciones periódicamente. Alerta cuando una condición se activa y la repite
 * cada `reraiseMs` mientras siga activa (sin inundar los canales); registra cuando se resuelve.
 */
export class AlertMonitor {
  private readonly activeSince = new Map<string, number>();
  private readonly lastRaised = new Map<string, number>();

  constructor(
    private readonly checks: AlertCheck[],
    private readonly alerts: AlertPort,
    private readonly logger: Logger,
    private readonly reraiseMs = 30 * 60_000,
  ) {}

  async tick(now = new Date()): Promise<string[]> {
    const raised: string[] = [];
    for (const check of this.checks) {
      let r: CheckResult;
      try {
        r = await check.evaluate(now);
      } catch (err) {
        this.logger.error(
          { check: check.code, err: err instanceof Error ? err.name : 'unknown' },
          'falló un chequeo',
        );
        continue;
      }
      const t = now.getTime();
      if (r.active) {
        if (!this.activeSince.has(check.code)) this.activeSince.set(check.code, t);
        const last = this.lastRaised.get(check.code);
        if (last === undefined || t - last >= this.reraiseMs) {
          await this.alerts.raise(check.code, check.severity, r.detail);
          this.lastRaised.set(check.code, t);
          raised.push(check.code);
        }
      } else if (this.activeSince.delete(check.code)) {
        this.lastRaised.delete(check.code);
        this.logger.info({ alert: check.code }, 'alerta resuelta');
      }
    }
    return raised;
  }
}

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

/** Condiciones de la sección 11 que se pueden evaluar desde la base de datos. */
export interface CapacityLimits {
  /** Chats simultáneos por robot (v1.5). */
  maxChatsPerRobot: number;
  /** p95 del tiempo de respuesta en 15 min por encima del cual se alerta. */
  responseP95AlertMs: number;
}

const DEFAULT_LIMITS: CapacityLimits = { maxChatsPerRobot: 3, responseP95AlertMs: 20_000 };

export function databaseChecks(
  prisma: PrismaClient,
  limits: CapacityLimits = DEFAULT_LIMITS,
): AlertCheck[] {
  return [
    {
      code: 'ROBOT_OVERLOADED',
      severity: 'ALTA',
      async evaluate() {
        const open = await openChatsByRobot(prisma);
        const robots = [...open]
          .filter(([, n]) => n > limits.maxChatsPerRobot)
          .map(([robotUser, chats]) => ({ robotUser, chats }));
        return {
          active: robots.length > 0,
          detail: { max: limits.maxChatsPerRobot, robots },
        };
      },
    },
    {
      code: 'RESPONSE_SLOW',
      severity: 'ALTA',
      async evaluate(now) {
        // Con pocas muestras el p95 no es confiable: mínimo 5 respuestas en la ventana.
        const rows = (await responseTimeByRobot(prisma, minutesAgo(now, 15))).filter(
          (r) => r.samples >= 5 && (r.p95Ms ?? 0) > limits.responseP95AlertMs,
        );
        return {
          active: rows.length > 0,
          detail: {
            thresholdMs: limits.responseP95AlertMs,
            robots: rows.map((r) => ({
              robotUser: r.robotUser,
              p95Ms: r.p95Ms,
              samples: r.samples,
            })),
          },
        };
      },
    },
    {
      code: 'SESSION_DOWN',
      severity: 'CRITICA',
      async evaluate() {
        const rows = await prisma.rpaSession.findMany({
          where: { status: 'DOWN' },
          select: { robotUser: true },
        });
        return { active: rows.length > 0, detail: { robots: rows.map((r) => r.robotUser) } };
      },
    },
    {
      code: 'HEARTBEAT_LOST',
      severity: 'CRITICA',
      async evaluate(now) {
        const rows = await prisma.rpaSession.findMany({
          where: { status: 'ACTIVE', lastHeartbeat: { lt: minutesAgo(now, 2) } },
          select: { robotUser: true },
        });
        // Un robot apagado en orden (STOPPED) o deshabilitado en el panel no es una caída.
        const off = new Set(
          (
            await prisma.robot.findMany({
              where: {
                robotUser: { in: rows.map((r) => r.robotUser) },
                OR: [{ state: 'STOPPED' }, { enabled: false }],
              },
              select: { robotUser: true },
            })
          ).map((r) => r.robotUser),
        );
        const lost = rows.map((r) => r.robotUser).filter((u) => !off.has(u));
        return { active: lost.length > 0, detail: { robots: lost } };
      },
    },
    {
      code: 'SELECTOR_BROKEN',
      severity: 'CRITICA',
      async evaluate() {
        // Tres acciones seguidas fallidas o inciertas de un mismo robot: probable cambio de interfaz.
        const robots = await prisma.rpaSession.findMany({ select: { robotUser: true } });
        const broken: string[] = [];
        for (const { robotUser } of robots) {
          const last = await prisma.rpaActionLog.findMany({
            where: { robotUser, result: { not: 'BLOCKED' } },
            orderBy: { seq: 'desc' },
            take: 3,
            select: { result: true },
          });
          if (
            last.length === 3 &&
            last.every((l) => l.result === 'ERROR' || l.result === 'UNCERTAIN')
          ) {
            broken.push(robotUser);
          }
        }
        return { active: broken.length > 0, detail: { robots: broken } };
      },
    },
    {
      code: 'SALE_NOT_TRANSFERRED',
      severity: 'CRITICA',
      async evaluate(now) {
        const rows = await prisma.sale.findMany({
          where: { transferredAt: null, createdAt: { lt: minutesAgo(now, 5) } },
          select: { conversationId: true },
        });
        return {
          active: rows.length > 0,
          detail: { conversationIds: rows.map((r) => r.conversationId) },
        };
      },
    },
    {
      code: 'CONVERSATIONS_NEEDS_REVIEW',
      severity: 'ALTA',
      async evaluate() {
        const n = await prisma.conversation.count({ where: { status: 'NEEDS_REVIEW' } });
        return { active: n > 0, detail: { count: n } };
      },
    },
    {
      code: 'SEND_UNCERTAIN',
      severity: 'ALTA',
      async evaluate() {
        const n = await prisma.message.count({ where: { status: 'UNCERTAIN' } });
        return { active: n > 0, detail: { count: n } };
      },
    },
    {
      code: 'CUSTOMER_UNANSWERED',
      severity: 'ALTA',
      async evaluate(now) {
        const n = await prisma.message.count({
          where: {
            direction: 'INBOUND',
            processedAt: null,
            createdAt: { lt: minutesAgo(now, 2) },
            conversation: { status: { in: [...OPEN_STATUSES] } },
          },
        });
        return { active: n > 0, detail: { count: n } };
      },
    },
    {
      code: 'LLM_PROVIDER_ERRORS',
      severity: 'ALTA',
      async evaluate(now) {
        const since = minutesAgo(now, 10);
        const [errors, calls] = await Promise.all([
          prisma.outboxEvent.count({ where: { type: 'NeedsReview', createdAt: { gte: since } } }),
          prisma.llmCall.count({ where: { createdAt: { gte: since } } }),
        ]);
        const total = errors + calls;
        return { active: total >= 10 && errors / total > 0.05, detail: { errors, total } };
      },
    },
    {
      code: 'LLM_FALLBACK_RATE',
      severity: 'ALTA',
      async evaluate(now) {
        const since = minutesAgo(now, 60);
        const [fallback, total] = await Promise.all([
          prisma.llmCall.count({
            where: { createdAt: { gte: since }, validationResult: 'FALLBACK' },
          }),
          prisma.llmCall.count({ where: { createdAt: { gte: since } } }),
        ]);
        return { active: total >= 20 && fallback / total > 0.05, detail: { fallback, total } };
      },
    },
  ];
}
