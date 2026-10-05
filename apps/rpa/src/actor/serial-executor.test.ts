import { describe, expect, it } from 'vitest';
import { ActorGate } from './actor-gate.js';
import { SerialExecutor } from './serial-executor.js';

describe('SerialExecutor', () => {
  it('ejecuta una tarea a la vez y en orden', async () => {
    const ex = new SerialExecutor();
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        ex.run(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 5));
          order.push(i);
          running--;
        }),
      ),
    );
    expect(maxRunning).toBe(1);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('un error no bloquea las siguientes tareas', async () => {
    const ex = new SerialExecutor();
    const a = ex.run(async () => {
      throw new Error('x');
    });
    const b = ex.run(async () => 'ok');
    await expect(a).rejects.toThrow('x');
    await expect(b).resolves.toBe('ok');
  });
});

describe('ActorGate', () => {
  it('bloquea hasta que se liberan todas las razones', async () => {
    const g = new ActorGate();
    g.pause('session');
    g.pause('kill');
    let opened = false;
    const w = g.waitUntilOpen().then(() => (opened = true));
    g.resume('session');
    await Promise.resolve();
    expect(opened).toBe(false);
    g.resume('kill');
    await w;
    expect(opened).toBe(true);
  });
});
