/**
 * Horario de trabajo de los robots (D-026, 15/10/2026), hora de Colombia (UTC-5, sin horario de
 * verano), p. ej. `07:00-22:00`. Se cambia en el panel (Robots → Horario); `ROBOT_WORK_HOURS` del
 * servidor es el valor inicial. Fuera de horario el robot no abre Abaya; al llegar la hora de fin
 * pasa a una pausa, termina sus chats, hace «Salir» y espera. Sin horario trabaja siempre.
 */
export interface WorkHours {
  /** Minutos desde la medianoche (hora de Colombia). */
  start: number;
  end: number;
}

const BOGOTA_OFFSET_MIN = -5 * 60;
const DAY_MIN = 24 * 60;

/** «07:00-22:00» → horario; vacío → null; mal escrito o que cruza la medianoche → error. */
export function parseWorkHours(raw: string | null | undefined): WorkHours | null {
  const v = raw?.trim();
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) throw new Error(`Horario inválido «${v}»: use HH:MM-HH:MM, por ejemplo 07:00-22:00`);
  const [h1, m1, h2, m2] = m.slice(1).map(Number) as [number, number, number, number];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) throw new Error(`Horario inválido «${v}»`);
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  if (end <= start) throw new Error(`Horario inválido «${v}»: la hora de fin debe ser posterior`);
  return { start, end };
}

/** Minuto del día en Colombia. */
export function bogotaMinute(now: Date): number {
  const utc = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (((utc + BOGOTA_OFFSET_MIN) % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

export function isWorkTime(h: WorkHours, now: Date): boolean {
  const m = bogotaMinute(now);
  return m >= h.start && m < h.end;
}

/** Milisegundos hasta el próximo inicio de turno (0 si ya está en horario). */
export function msUntilStart(h: WorkHours, now: Date): number {
  if (isWorkTime(h, now)) return 0;
  const m = bogotaMinute(now);
  const minutes = m < h.start ? h.start - m : DAY_MIN - m + h.start;
  return minutes * 60_000 - now.getUTCSeconds() * 1_000 - now.getUTCMilliseconds();
}

/** Milisegundos hasta el fin del turno (0 si está fuera de horario). */
export function msUntilEnd(h: WorkHours, now: Date): number {
  if (!isWorkTime(h, now)) return 0;
  const minutes = h.end - bogotaMinute(now);
  return minutes * 60_000 - now.getUTCSeconds() * 1_000 - now.getUTCMilliseconds();
}

/** Formato canónico («7:30 - 21:45» → «07:30-21:45»); null sin horario. */
export function normalizeWorkHours(raw: string | null | undefined): string | null {
  const h = parseWorkHours(raw);
  return h ? `${formatMinute(h.start)}-${formatMinute(h.end)}` : null;
}

export function formatMinute(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
