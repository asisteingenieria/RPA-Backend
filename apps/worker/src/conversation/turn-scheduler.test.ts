import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnScheduler } from './turn-scheduler.js';

describe('TurnScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('una ráfaga de 3 mensajes produce un solo turno, 4 s después del último', async () => {
    const calls: string[] = [];
    const s = new TurnScheduler(async (id) => void calls.push(id));
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(2_000);
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(3_000);
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['c1']);
  });

  it('un turno a la vez por conversación; lo que llega durante el turno va al siguiente', async () => {
    let active = 0;
    let maxActive = 0;
    const calls: number[] = [];
    let release!: () => void;
    const s = new TurnScheduler(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(Date.now());
      if (calls.length === 1) await new Promise<void>((r) => (release = r));
      active--;
    });
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(4_000); // empieza el turno 1 (bloqueado)
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(4_000); // el 2 queda pendiente
    expect(calls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(maxActive).toBe(1);
  });

  it('conversaciones distintas se procesan en paralelo', async () => {
    let active = 0;
    let maxActive = 0;
    const s = new TurnScheduler(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1_000));
      active--;
    });
    for (let i = 0; i < 20; i++) s.notify(`c${i}`);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(maxActive).toBe(20);
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('un error en un turno no detiene la conversación', async () => {
    const errors: string[] = [];
    let n = 0;
    const s = new TurnScheduler(
      async () => {
        if (++n === 1) throw new Error('x');
      },
      { onError: (id) => errors.push(id) },
    );
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(4_000);
    s.notify('c1');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(errors).toEqual(['c1']);
    expect(n).toBe(2);
  });
});
