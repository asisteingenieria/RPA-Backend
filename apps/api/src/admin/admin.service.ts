import type { PrismaClient } from '@abaya/db';
import { KILL_SWITCH_KEY } from '@abaya/domain';
import type { FlagStore } from './flags.js';

/** Inicio del día en Bogotá (UTC-5, sin horario de verano). */
export function startOfBogotaDay(now: Date): Date {
  const bogota = new Date(now.getTime() - 5 * 3_600_000);
  return new Date(
    Date.UTC(bogota.getUTCFullYear(), bogota.getUTCMonth(), bogota.getUTCDate()) + 5 * 3_600_000,
  );
}

/**
 * Datos del panel de operación (F7). Solo estados, conteos e identificadores: nunca
 * contenido de mensajes ni datos personales (regla 6).
 */
export class AdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly flags: FlagStore,
  ) {}

  async overview(now = new Date()) {
    const today = startOfBogotaDay(now);
    const [sessions, byStatus, transferredToday, salesToday, recentErrors, killSwitch] =
      await Promise.all([
        this.prisma.rpaSession.findMany({ orderBy: { robotUser: 'asc' } }),
        this.prisma.conversation.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.sale.count({ where: { transferredAt: { gte: today } } }),
        this.prisma.sale.count({ where: { createdAt: { gte: today } } }),
        this.prisma.rpaActionLog.findMany({
          where: { result: { in: ['ERROR', 'UNCERTAIN'] } },
          orderBy: { seq: 'desc' },
          take: 20,
          select: {
            robotUser: true,
            action: true,
            abayaChatId: true,
            result: true,
            createdAt: true,
          },
        }),
        this.killSwitchActive(),
      ]);
    const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    return {
      generatedAt: now.toISOString(),
      killSwitch,
      sessions: sessions.map((s) => ({
        robotUser: s.robotUser,
        status: s.status,
        lastHeartbeat: s.lastHeartbeat,
        lastLoginAt: s.lastLoginAt,
        consecutiveFails: s.consecutiveFails,
      })),
      conversations: {
        active: (counts.ACTIVE ?? 0) + (counts.WAITING_CONSENT ?? 0),
        transferring: counts.TRANSFERRING ?? 0,
        needsReview: counts.NEEDS_REVIEW ?? 0,
        byStatus: counts,
      },
      sales: { today: salesToday, transferredToday },
      recentErrors,
    };
  }

  /** Lo que requiere un humano: conversaciones en revisión y envíos inciertos. */
  async reviewQueue() {
    const [conversations, uncertain] = await Promise.all([
      this.prisma.conversation.findMany({
        where: { status: 'NEEDS_REVIEW' },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: { id: true, abayaChatId: true, robotUser: true, stage: true, updatedAt: true },
      }),
      this.prisma.message.findMany({
        where: { status: 'UNCERTAIN' },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          attempts: true,
          createdAt: true,
          conversation: { select: { id: true, abayaChatId: true, robotUser: true } },
        },
      }),
    ]);
    return { conversations, uncertainMessages: uncertain };
  }

  async killSwitchActive(): Promise<boolean> {
    return (await this.flags.get(KILL_SWITCH_KEY)) === '1';
  }

  async setKillSwitch(active: boolean, actor: string) {
    await this.flags.set(KILL_SWITCH_KEY, active ? '1' : '0');
    await this.audit(actor, active ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF');
    return { killSwitch: active };
  }

  /**
   * Reset manual de una sesión en DOWN (sección 6.1: tras 3 fallos el robot no insiste).
   * El rpa vuelve a intentar al reiniciarse.
   */
  async resetSession(robotUser: string, actor: string) {
    const r = await this.prisma.rpaSession.updateMany({
      where: { robotUser, status: 'DOWN' },
      data: { status: 'RELOGGING', consecutiveFails: 0 },
    });
    if (r.count) await this.audit(actor, 'SESSION_RESET', robotUser);
    return {
      reset: r.count === 1,
      note: r.count ? 'Reinicie el proceso rpa de este robot.' : 'La sesión no estaba en DOWN.',
    };
  }

  async auditLog(limit = 50) {
    return this.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  }

  private async audit(actor: string, action: string, target?: string) {
    await this.prisma.adminAuditLog.create({ data: { actor, action, target: target ?? null } });
  }
}
