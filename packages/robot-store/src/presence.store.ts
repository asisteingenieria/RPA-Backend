import type { PrismaClient } from '@abaya/db';

/** Presencia del robot hijo en el padre (v1.4, sección 2.6). */
export const PRESENCE_EVERY_MS = 15_000;
/** Sin presencia por más de esto, otra instancia puede tomar el robot (equipo caído). */
export const PRESENCE_STALE_MS = 60_000;

export interface InstanceInfo {
  robotUser: string;
  instanceId: string;
  host: string;
  version: string;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'DISABLED' }
  | { ok: false; reason: 'DUPLICATE'; onlineHost: string | null };

export type BeatResult = 'OK' | 'LOST' | 'DISABLED';

export interface PresenceStore {
  claim(i: InstanceInfo, now: Date): Promise<ClaimResult>;
  beat(robotUser: string, instanceId: string, now: Date): Promise<BeatResult>;
  release(robotUser: string, instanceId: string, now: Date): Promise<void>;
}

export class PrismaPresenceStore implements PresenceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(i: InstanceInfo, now: Date): Promise<ClaimResult> {
    // Modo .env (desarrollo): el robot se registra solo. Los hijos instalados ya existen.
    const robot = await this.prisma.robot.upsert({
      where: { robotUser: i.robotUser },
      create: { robotUser: i.robotUser },
      update: {},
    });
    if (!robot.enabled) return { ok: false, reason: 'DISABLED' };
    // Atómico: si dos equipos arrancan a la vez, PostgreSQL deja ganar a uno solo.
    const r = await this.prisma.robot.updateMany({
      where: {
        robotUser: i.robotUser,
        enabled: true,
        OR: [
          { instanceId: null },
          { state: 'STOPPED' },
          { lastSeenAt: null },
          { lastSeenAt: { lt: new Date(now.getTime() - PRESENCE_STALE_MS) } },
        ],
      },
      data: {
        instanceId: i.instanceId,
        host: i.host,
        version: i.version,
        state: 'ONLINE',
        startedAt: now,
        lastSeenAt: now,
        stoppedAt: null,
      },
    });
    if (r.count === 1) return { ok: true };
    const current = await this.prisma.robot.update({
      where: { robotUser: i.robotUser },
      data: { lastRejectedHost: i.host, lastRejectedAt: now },
    });
    return current.enabled
      ? { ok: false, reason: 'DUPLICATE', onlineHost: current.host }
      : { ok: false, reason: 'DISABLED' };
  }

  async beat(robotUser: string, instanceId: string, now: Date): Promise<BeatResult> {
    const r = await this.prisma.robot.updateMany({
      where: { robotUser, instanceId, enabled: true },
      data: { lastSeenAt: now, state: 'ONLINE' },
    });
    if (r.count === 1) return 'OK';
    const robot = await this.prisma.robot.findUnique({ where: { robotUser } });
    return robot && !robot.enabled ? 'DISABLED' : 'LOST';
  }

  async release(robotUser: string, instanceId: string, now: Date): Promise<void> {
    await this.prisma.robot.updateMany({
      where: { robotUser, instanceId },
      data: { state: 'STOPPED', stoppedAt: now, instanceId: null },
    });
  }
}
