import { describe, expect, it } from 'vitest';
import {
  bogotaMinute,
  formatMinute,
  isWorkTime,
  msUntilEnd,
  msUntilStart,
  parseWorkHours,
} from './work-hours.js';

/** Hora de Colombia (UTC-5) → Date. */
const co = (hhmm: string) => new Date(`2026-10-15T${hhmm}:00-05:00`);
const h = parseWorkHours('07:00-22:00')!;

describe('horario del robot', () => {
  it('lee HH:MM-HH:MM; vacío = sin horario; rechaza mal escrito o que cruza la medianoche', () => {
    expect(h).toEqual({ start: 420, end: 1320 });
    expect(parseWorkHours('7:30 - 21:45')).toEqual({ start: 450, end: 1305 });
    expect(parseWorkHours('')).toBeNull();
    expect(parseWorkHours(undefined)).toBeNull();
    expect(() => parseWorkHours('7-22')).toThrow('HH:MM-HH:MM');
    expect(() => parseWorkHours('22:00-07:00')).toThrow('posterior');
    expect(() => parseWorkHours('07:00-24:00')).toThrow('inválido');
  });

  it('usa la hora de Colombia, no la del equipo', () => {
    expect(bogotaMinute(co('06:59'))).toBe(419);
    expect(bogotaMinute(new Date('2026-10-16T03:00:00Z'))).toBe(22 * 60); // 22:00 en Colombia
    expect(formatMinute(420)).toBe('07:00');
  });

  it('en horario de 07:00 a 22:00 (22:00 ya es fuera)', () => {
    expect(isWorkTime(h, co('06:59'))).toBe(false);
    expect(isWorkTime(h, co('07:00'))).toBe(true);
    expect(isWorkTime(h, co('21:59'))).toBe(true);
    expect(isWorkTime(h, co('22:00'))).toBe(false);
  });

  it('cuánto falta para empezar y para terminar', () => {
    expect(msUntilStart(h, co('06:30'))).toBe(30 * 60_000);
    expect(msUntilStart(h, co('22:30'))).toBe(8.5 * 3_600_000);
    expect(msUntilStart(h, co('10:00'))).toBe(0);
    expect(msUntilEnd(h, co('21:00'))).toBe(3_600_000);
    expect(msUntilEnd(h, co('23:00'))).toBe(0);
  });
});
