import { Prisma, type PrismaClient } from './generated/prisma/client.js';

/**
 * Fecha como `timestamp` sin zona: Prisma guarda las fechas en UTC y la sesión de PostgreSQL
 * puede estar en otra zona (p. ej. America/Bogota); así la comparación no depende de ella.
 */
export const utcParam = (d: Date) => Prisma.sql`${d.toISOString().slice(0, 23)}::timestamp`;

/** Conversaciones que siguen en la bandeja del robot (cuentan para el tope de chats). */
export const OPEN_CHAT_STATUSES = ['ACTIVE', 'WAITING_CONSENT', 'TRANSFERRING'] as const;

export interface ResponseTimeRow {
  robotUser: string;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

/**
 * Tiempo de respuesta al cliente por robot (v1.5): desde que el robot detectó el primer
 * mensaje de la ráfaga (`respondsToAt`) hasta que Abaya confirmó la respuesta (`sentAt`).
 * Ambas marcas son del reloj del mismo robot.
 */
export async function responseTimeByRobot(
  prisma: PrismaClient,
  from: Date,
  robotUser?: string,
): Promise<ResponseTimeRow[]> {
  const rows = await prisma.$queryRaw<
    {
      robotUser: string;
      samples: number;
      p50: number | null;
      p95: number | null;
      max: number | null;
    }[]
  >`
    SELECT c."robotUser" AS "robotUser",
           count(*)::int AS samples,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
           max(ms) AS max
    FROM (
      SELECT m."conversationId",
             EXTRACT(EPOCH FROM (m."sentAt" - m."respondsToAt")) * 1000 AS ms
      FROM "Message" m
      WHERE m."sentAt" >= ${utcParam(from)} AND m."respondsToAt" IS NOT NULL
    ) t
    JOIN "Conversation" c ON c.id = t."conversationId"
    ${robotUser ? Prisma.sql`WHERE c."robotUser" = ${robotUser}` : Prisma.empty}
    GROUP BY c."robotUser"
    ORDER BY c."robotUser"`;
  const round = (v: number | null) => (v === null ? null : Math.max(0, Math.round(Number(v))));
  return rows.map((r) => ({
    robotUser: r.robotUser,
    samples: r.samples,
    p50Ms: round(r.p50),
    p95Ms: round(r.p95),
    maxMs: round(r.max),
  }));
}

/** Chats abiertos por robot (los que siguen en su bandeja de Abaya). */
export async function openChatsByRobot(prisma: PrismaClient): Promise<Map<string, number>> {
  const rows = await prisma.conversation.groupBy({
    by: ['robotUser'],
    where: { status: { in: [...OPEN_CHAT_STATUSES] } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.robotUser, r._count._all]));
}
