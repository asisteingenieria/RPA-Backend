import type { PrismaClient } from '@abaya/db';

/**
 * D-042: sin heartbeat de la sesión en este tiempo, el robot se considera sin conexión con Avaya
 * (corte de red del PC, reconexión en curso). El heartbeat se guarda cada 30 s.
 */
export const ROBOT_OFFLINE_AFTER_MS = 2 * 60_000;

/**
 * D-042: robots que hoy no pueden atender (sesión no activa o sin heartbeat reciente). Mientras
 * tanto el cliente pudo escribir y el robot no lo ve: a sus conversaciones no se les envía
 * reactivación ni se cierran por inactividad (como con la pausa). Un robot sin registro de sesión
 * no se bloquea.
 */
export async function offlineRobots(prisma: PrismaClient, now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - ROBOT_OFFLINE_AFTER_MS);
  const rows = await prisma.rpaSession.findMany({
    where: { OR: [{ status: { not: 'ACTIVE' } }, { lastHeartbeat: { lt: since } }] },
    select: { robotUser: true },
  });
  return new Set(rows.map((r) => r.robotUser));
}
