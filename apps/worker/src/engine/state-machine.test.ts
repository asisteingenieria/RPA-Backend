import { STAGES, type Stage } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_INTENTS,
  TERMINAL_STAGES,
  missingProfileFields,
  parseMenuOption,
  transition,
} from './state-machine.js';
import { INTENTS, type Profile } from './types.js';

const fullPorta: Profile = {
  process: 'PORTABILIDAD',
  name: 'Ana',
  currentOperator: 'Otro',
  usage: 'redes',
};

describe('transiciones del diagrama (sección 6.3.2)', () => {
  it.each<[Stage, string, Partial<Parameters<typeof transition>[0]>, Stage]>([
    ['MENU', 'ELIGE_OPCION', { option: 'A' }, 'PERFIL'],
    ['MENU', 'ELIGE_OPCION', { option: 'B' }, 'PERFIL'],
    ['MENU', 'ELIGE_OPCION', { option: 'C' }, 'PERFIL'],
    ['MENU', 'ELIGE_OPCION', { option: 'D' }, 'SOPORTE'],
    ['MENU', 'FUERA_DE_ALCANCE', {}, 'ESCALAR'],
    ['PERFIL', 'DA_DATO', { profile: fullPorta }, 'OFERTA'],
    ['PERFIL', 'DA_DATO', { profile: { process: 'PORTABILIDAD', name: 'Ana' } }, 'PERFIL'],
    ['PERFIL', 'FUERA_DE_ALCANCE', {}, 'ESCALAR'],
    ['OFERTA', 'OBJECION', {}, 'OBJECIONES'],
    ['OFERTA', 'ACEPTA_PLAN', { acceptedPlanCode: 'P1' }, 'AUTORIZACION'],
    ['OFERTA', 'FUERA_DE_ALCANCE', {}, 'ESCALAR'],
    ['OBJECIONES', 'PREGUNTA', {}, 'OFERTA'],
    ['OBJECIONES', 'NO_INTERESADO', {}, 'CIERRE_SIN_VENTA'],
    ['OBJECIONES', 'FUERA_DE_ALCANCE', {}, 'ESCALAR'],
    ['AUTORIZACION', 'AUTORIZA', {}, 'TRANSFERENCIA'],
    ['AUTORIZACION', 'NO_AUTORIZA', {}, 'CIERRE_SIN_VENTA'],
  ])('%s + %s → %s', (stage, intent, extra, to) => {
    const r = transition({ stage, intent: intent as never, profile: {}, ...extra });
    expect(r).toEqual({ ok: true, to });
  });
});

describe('transiciones prohibidas', () => {
  it('ACEPTA_PLAN sin plan válido se rechaza', () => {
    expect(transition({ stage: 'OFERTA', intent: 'ACEPTA_PLAN', profile: {} }).ok).toBe(false);
  });

  it('no se puede autorizar fuera de AUTORIZACION', () => {
    for (const stage of ['MENU', 'PERFIL', 'OFERTA', 'OBJECIONES'] as const) {
      expect(transition({ stage, intent: 'AUTORIZA', profile: fullPorta }).ok).toBe(false);
    }
  });

  it('no se puede saltar de MENU a OFERTA ni a AUTORIZACION', () => {
    for (const intent of INTENTS) {
      const r = transition({
        stage: 'MENU',
        intent,
        option: 'A',
        profile: fullPorta,
        acceptedPlanCode: 'P1',
      });
      if (r.ok)
        expect(['MENU', 'PERFIL', 'SOPORTE', 'CIERRE_SIN_VENTA', 'ESCALAR']).toContain(r.to);
    }
  });

  it('los estados terminales no aceptan nada', () => {
    for (const stage of TERMINAL_STAGES) {
      for (const intent of INTENTS) {
        expect(transition({ stage, intent, profile: fullPorta }).ok).toBe(false);
      }
    }
  });

  it('a TRANSFERENCIA solo se llega desde AUTORIZACION con AUTORIZA', () => {
    for (const stage of STAGES) {
      for (const intent of INTENTS) {
        const r = transition({
          stage,
          intent,
          option: 'A',
          profile: fullPorta,
          acceptedPlanCode: 'P1',
        });
        if (r.ok && r.to === 'TRANSFERENCIA') {
          expect([stage, intent]).toEqual(['AUTORIZACION', 'AUTORIZA']);
        }
      }
    }
  });

  it('todo estado no terminal permite escalar', () => {
    for (const stage of STAGES.filter((s) => !TERMINAL_STAGES.has(s) && s !== 'AUTORIZACION')) {
      expect(ALLOWED_INTENTS[stage]).toContain('FUERA_DE_ALCANCE');
    }
  });
});

describe('perfil requerido', () => {
  it('portabilidad exige operador actual; línea nueva no', () => {
    expect(missingProfileFields({ process: 'PORTABILIDAD', name: 'A', usage: 'x' })).toEqual([
      'currentOperator',
    ]);
    expect(missingProfileFields({ process: 'LINEA_NUEVA', name: 'A', usage: 'x' })).toEqual([]);
    expect(missingProfileFields({})).toEqual(['process']);
  });
});

describe('parseMenuOption', () => {
  it.each([
    ['A', 'A'],
    ['b', 'B'],
    [' Opción C ', 'C'],
    ['la opcion d', 'D'],
    ['1', 'A'],
    ['4.', 'D'],
    ['*B*', 'B'],
  ])('%s → %s', (input, out) => {
    expect(parseMenuOption(input)).toBe(out);
  });

  it.each(['Hola', 'quiero la a y la b', 'A ver', 'E', '5'])('%s → indefinido', (input) => {
    expect(parseMenuOption(input)).toBeUndefined();
  });
});
