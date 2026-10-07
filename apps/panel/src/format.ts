import { ApiError } from './api.js';

export const time = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(new Date(iso))
    : '—';

/** "hace 12 s", "hace 3 min"… para la última señal de un robot. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.round(s / 3600)} h`;
  return time(iso);
}

export const message = (err: unknown, fallback: string) =>
  err instanceof ApiError && err.status < 500 ? err.message : fallback;

export const ms = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`;
