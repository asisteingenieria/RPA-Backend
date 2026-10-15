import type { PrismaClient } from '@abaya/db';
import { normalizeWorkHours } from '@abaya/domain';

/** Clave de `AppSetting` con el horario de los robots (D-026). */
export const WORK_HOURS_KEY = 'robotWorkHours';

export interface WorkHoursSetting {
  /** `07:00-22:00` (hora de Colombia) o null = los robots trabajan siempre. */
  hours: string | null;
  /** PANEL = lo guardó un ADMIN; SERVIDOR = `ROBOT_WORK_HOURS` del .env (valor inicial). */
  source: 'PANEL' | 'SERVIDOR';
  updatedBy: string | null;
  updatedAt: Date | null;
}

/**
 * Horario vigente: el del panel si alguien lo guardó; si no, `ROBOT_WORK_HOURS` del servidor.
 * Lo usan la pasarela (cada robot lo consulta cada minuto) y el robot en modo directo.
 */
export async function readWorkHours(
  prisma: PrismaClient,
  envDefault: string | null | undefined,
): Promise<WorkHoursSetting> {
  const row = await prisma.appSetting.findUnique({ where: { key: WORK_HOURS_KEY } });
  if (!row) {
    return {
      hours: safeNormalize(envDefault),
      source: 'SERVIDOR',
      updatedBy: null,
      updatedAt: null,
    };
  }
  const value = row.value as { hours?: unknown } | null;
  return {
    hours: typeof value?.hours === 'string' ? safeNormalize(value.hours) : null,
    source: 'PANEL',
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

/** Guarda el horario (ya validado y normalizado) o null = siempre. */
export async function saveWorkHours(prisma: PrismaClient, hours: string | null, actor: string) {
  await prisma.appSetting.upsert({
    where: { key: WORK_HOURS_KEY },
    create: { key: WORK_HOURS_KEY, value: { hours }, updatedBy: actor },
    update: { value: { hours }, updatedBy: actor },
  });
}

function safeNormalize(raw: string | null | undefined): string | null {
  try {
    return normalizeWorkHours(raw);
  } catch {
    return null;
  }
}
