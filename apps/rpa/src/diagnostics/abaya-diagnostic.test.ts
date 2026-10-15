import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { MemoryActionLog } from '../audit/action-log.js';
import { MemoryKillSwitch } from '../safety/kill-switch.js';
import { AbayaDiagnostic, type DiagnosticActor } from './abaya-diagnostic.js';

/** Actor falso: solo el paso «disponible» (los anteriores se prueban contra el simulador). */
function fakeActor(opts: { returns?: boolean; arrives?: string[]; options?: string[] }) {
  let state = 'Login';
  let cases: string[] = [];
  const switches: string[] = [];
  const actor: DiagnosticActor = {
    readAgentState: async () => ({
      current: state,
      options: opts.options ?? ['Disponible', 'Almuerzo', 'FinTurno'],
    }),
    switchAgentState: async (name) => {
      switches.push(name);
      if (name === 'Disponible') {
        state = name;
        cases = opts.arrives ?? [];
        return 'OK';
      }
      if (opts.returns === false) return 'NOT_CHANGED';
      state = cases.length ? 'Trabajando (Pend. Aux.)' : name;
      return cases.length ? 'NOT_CHANGED' : 'OK';
    },
    readInboxChatIds: async () => cases,
  };
  return { actor, switches, state: () => state };
}

function run(actor: DiagnosticActor) {
  return new AbayaDiagnostic({
    robotUser: 'robot-ventas-01',
    driver: {
      open: async () => undefined,
      page: {} as Page,
      login: async () => 'OK',
      logout: async () => true,
      close: async () => undefined,
    },
    actor,
    killSwitch: new MemoryKillSwitch(),
    actionLog: new MemoryActionLog(),
    credentials: () => ({ username: 'robot-ventas-01', password: 'x' }),
  });
}

describe('AbayaDiagnostic, paso disponible (D-020)', () => {
  // Llama directo al paso (el formulario de login necesita una página real).
  const available = (d: AbayaDiagnostic) =>
    (d as unknown as { available(): Promise<{ ok: boolean; detail: string }> }).available();

  it('sin «Login» en el menú vuelve a FinTurno', async () => {
    const f = fakeActor({});
    const r = await available(run(f.actor));
    expect(r).toEqual({ ok: true, detail: '«Disponible» OK y de vuelta a «FinTurno»' });
    expect(f.switches).toEqual(['Disponible', 'FinTurno']);
  });

  it('si entra un caso lo avisa y ySocial deja la pausa pendiente', async () => {
    const f = fakeActor({ arrives: ['9876543210'] });
    const r = await available(run(f.actor));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('quedó «Trabajando (Pend. Aux.)»');
    expect(r.detail).toContain('ATENCIÓN: entró 1 caso(s)');
  });

  it('si no logra volver lo dice para cambiarlo a mano', async () => {
    const f = fakeActor({ returns: false });
    const r = await available(run(f.actor));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('NO volvió a «FinTurno»');
    expect(f.state()).toBe('Disponible');
  });

  it('sin pausa a la cual volver no se pone Disponible', async () => {
    const f = fakeActor({ options: ['Disponible', 'Almuerzo'] });
    const r = await available(run(f.actor));
    expect(r.ok).toBe(false);
    expect(f.switches).toEqual([]);
  });
});
