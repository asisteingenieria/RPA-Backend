import type { PrismaClient } from '@abaya/db';

export type SessionStatus = 'ACTIVE' | 'RELOGGING' | 'DOWN' | 'PAUSED';

export interface SessionRecord {
  robotUser: string;
  status: SessionStatus;
  lastHeartbeat: Date;
  lastLoginAt: Date | null;
  consecutiveFails: number;
}

/** Persistencia de `RpaSession` (sección 5). */
export interface SessionRepository {
  get(robotUser: string): Promise<SessionRecord | null>;
  save(record: SessionRecord): Promise<void>;
}

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(robotUser: string): Promise<SessionRecord | null> {
    const r = await this.prisma.rpaSession.findUnique({ where: { robotUser } });
    return r ? { ...r, status: r.status as SessionStatus } : null;
  }

  async save(record: SessionRecord): Promise<void> {
    await this.prisma.rpaSession.upsert({
      where: { robotUser: record.robotUser },
      create: record,
      update: record,
    });
  }
}

export class MemorySessionRepository implements SessionRepository {
  readonly records = new Map<string, SessionRecord>();
  async get(robotUser: string) {
    const r = this.records.get(robotUser);
    return r ? { ...r } : null;
  }
  async save(record: SessionRecord) {
    this.records.set(record.robotUser, { ...record });
  }
}
