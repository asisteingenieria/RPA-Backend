import { GENESIS_HASH, chainHash } from '@abaya/crypto';
import type { PrismaClient } from '@abaya/db';
import type { RpaAction, RpaActionResult } from '@abaya/domain';

export interface ActionLogEntry {
  robotUser: string;
  action: RpaAction;
  abayaChatId: string | null;
  result: RpaActionResult;
  durationMs: number;
  traceRef: string | null;
  createdAt: Date;
}

export interface StoredActionLog extends ActionLogEntry {
  prevHash: string;
  hash: string;
}

/** Datos que entran al hash: todo menos los propios hashes. */
export function actionLogHashInput(e: ActionLogEntry) {
  return {
    robotUser: e.robotUser,
    action: e.action,
    abayaChatId: e.abayaChatId,
    result: e.result,
    durationMs: e.durationMs,
    traceRef: e.traceRef,
    createdAt: e.createdAt.toISOString(),
  };
}

/** Regla 9: toda acción queda en RpaActionLog con cadena de hashes (por usuario robot). */
export interface ActionLog {
  append(entry: ActionLogEntry): Promise<StoredActionLog>;
}

export class PrismaActionLog implements ActionLog {
  constructor(private readonly prisma: PrismaClient) {}

  async append(entry: ActionLogEntry): Promise<StoredActionLog> {
    // Serializable: dos escrituras concurrentes no pueden encadenar al mismo prevHash
    // (además `hash` es único en BD).
    return this.prisma.$transaction(
      async (tx) => {
        const last = await tx.rpaActionLog.findFirst({
          where: { robotUser: entry.robotUser },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { hash: true },
        });
        const prevHash = last?.hash ?? GENESIS_HASH;
        const hash = chainHash(prevHash, actionLogHashInput(entry));
        await tx.rpaActionLog.create({ data: { ...entry, prevHash, hash } });
        return { ...entry, prevHash, hash };
      },
      { isolationLevel: 'Serializable' },
    );
  }
}

export class MemoryActionLog implements ActionLog {
  readonly entries: StoredActionLog[] = [];

  async append(entry: ActionLogEntry): Promise<StoredActionLog> {
    const prev = [...this.entries].reverse().find((e) => e.robotUser === entry.robotUser);
    const prevHash = prev?.hash ?? GENESIS_HASH;
    const stored = { ...entry, prevHash, hash: chainHash(prevHash, actionLogHashInput(entry)) };
    this.entries.push(stored);
    return stored;
  }
}
