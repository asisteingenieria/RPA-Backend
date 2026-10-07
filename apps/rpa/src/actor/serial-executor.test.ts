import { describe, expect, it } from 'vitest';
import { ActorGate } from './actor-gate.js';
import { PRIORITY, SerialExecutor } from './serial-executor.js';

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

describe('SerialExecutor con prioridad (v1.5)', () => {
  it('mientras una acción corre, las que esperan salen por urgencia y luego por llegada', async () => {
    const ex = new SerialExecutor();
    const order: string[] = [];
    let release!: () => void;
    const first = ex.run(
      () => new Promise<void>((r) => (release = () => (order.push('cerrar-en-curso'), r()))),
      PRIORITY.CLOSE,
    );
    const job = (name: string, p: number) => ex.run(async () => void order.push(name), p);
    const all = [
      job('cerrar-2', PRIORITY.CLOSE),
      job('leer-bandeja', PRIORITY.READ_INBOX),
      job('transferir', PRIORITY.TRANSFER),
      job('enviar-a', PRIORITY.SEND),
      job('enviar-b', PRIORITY.SEND),
    ];
    expect(ex.size).toBe(6);
    await new Promise((r) => setTimeout(r, 0)); // la primera tarea ya arrancó
    release();
    await Promise.all([first, ...all]);
    // La acción en curso nunca se interrumpe; después, urgencia y orden de llegada.
    expect(order).toEqual([
      'cerrar-en-curso',
      'enviar-a',
      'enviar-b',
      'transferir',
      'leer-bandeja',
      'cerrar-2',
    ]);
    expect(ex.size).toBe(0);
  });

  it('nunca ejecuta dos a la vez aunque lleguen con distinta prioridad', async () => {
    const ex = new SerialExecutor();
    let running = 0;
    let max = 0;
    await Promise.all(
      [4, 0, 2, 0, 3, 1].map((p) =>
        ex.run(async () => {
          running++;
          max = Math.max(max, running);
          await new Promise((r) => setTimeout(r, 2));
          running--;
        }, p),
      ),
    );
    expect(max).toBe(1);
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
