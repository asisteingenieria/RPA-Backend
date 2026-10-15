import { MemoryAlertAdapter } from '@abaya/alerts';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import { ShiftEnd, type ShiftEndActor } from './shift-end.js';

const OPTIONS = ['Disponible', 'Trabajando', 'Login', 'Break', 'FinTurno'];

/** Actor falso: con chats ySocial deja la pausa pendiente; cada revisión termina un chat. */
function fake(opts: { chats: number; killSwitch?: boolean }) {
  let state = opts.chats ? 'Trabajando' : 'Disponible';
  let chats = opts.chats;
  const switches: string[] = [];
  const actor: ShiftEndActor = {
    readAgentState: async () => ({ current: state, options: OPTIONS }),
    switchAgentState: async (name) => {
      switches.push(name);
      if (opts.killSwitch) return 'BLOCKED_KILL_SWITCH';
      if (chats) {
        state = 'Trabajando (Pend. Aux.)';
        return 'NOT_CHANGED';
      }
      state = name;
      return 'OK';
    },
    readInboxChatIds: async () => {
      const ids = Array.from({ length: chats }, (_, i) => String(1000 + i));
      if (chats) chats--;
      if (!chats && state.includes('Pend')) state = 'FinTurno';
      return ids;
    },
  };
  return { actor, switches, state: () => state };
}

function run(actor: ShiftEndActor, alertAfterMs = 60_000) {
  let t = 0;
  const alerts = new MemoryAlertAdapter();
  const done = new ShiftEnd({
    robotUser: 'robot-ventas-01',
    actor,
    alerts,
    logger: createLogger('t', { level: 'silent' }),
    everyMs: 30_000,
    alertAfterMs,
    sleep: async (ms) => void (t += ms),
    now: () => t,
  }).run();
  return { done, alerts, elapsed: () => t };
}

describe('fin del turno', () => {
  it('sin chats: pasa a FinTurno y termina enseguida', async () => {
    const f = fake({ chats: 0 });
    const r = run(f.actor);
    await r.done;
    expect(f.switches).toEqual(['FinTurno']);
    expect(f.state()).toBe('FinTurno');
    expect(r.elapsed()).toBe(0);
  });

  it('con chats: pausa pendiente, sigue atendiendo y termina con la bandeja vacía', async () => {
    const f = fake({ chats: 2 });
    const r = run(f.actor);
    await r.done;
    expect(f.switches).toEqual(['FinTurno']); // no insiste: la pausa quedó pendiente
    expect(r.elapsed()).toBe(60_000);
    expect(r.alerts.raised).toEqual([]);
  });

  it('si los chats tardan, alerta una vez a supervisión y sigue esperando (nunca los abandona)', async () => {
    const f = fake({ chats: 5 });
    const r = run(f.actor, 60_000);
    await r.done;
    expect(r.alerts.raised).toEqual([
      expect.objectContaining({ code: 'SHIFT_END_PENDING', severity: 'ALTA' }),
    ]);
  });

  it('con kill switch no cambia el estado: reintenta hasta poder', async () => {
    const f = fake({ chats: 0, killSwitch: true });
    let tries = 0;
    const actor: ShiftEndActor = {
      ...f.actor,
      switchAgentState: async (name) => (++tries < 3 ? f.actor.switchAgentState(name) : 'OK'),
    };
    await run(actor).done;
    expect(tries).toBe(3);
  });
});
