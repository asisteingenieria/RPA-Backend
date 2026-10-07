import { describe, expect, it } from 'vitest';
import type { Plan } from '../../catalog/catalog.js';
import type { TurnOutput } from '../output-schema.js';
import { validateTurnOutput, type ValidationContext } from './validators.js';

const plan = (code: string, process: Plan['process'] = 'PORTABILIDAD'): Plan => ({
  code,
  process,
  name: `Plan ${code}`,
  dataText: '10 GB',
  sharedDataText: null,
  includesText: null,
  extrasText: null,
  unlimitedAppsText: null,
  callsText: null,
  priceCop: 39900,
  discountText: null,
  hash: `hash-${code}`,
});

const ctx: ValidationContext = {
  stage: 'OFERTA',
  process: 'PORTABILIDAD',
  availablePlans: [plan('P1'), plan('P2')],
};

const base = (over: Partial<TurnOutput> = {}): TurnOutput => ({
  intent: 'PREGUNTA',
  reply: 'Claro, te cuento con gusto.',
  option: null,
  planCode: null,
  extracted: { name: null, currentOperator: null, usage: null },
  confidence: 'ALTA',
  ...over,
});

const errorsOf = (raw: unknown, c = ctx) => {
  const r = validateTurnOutput(raw, c);
  return r.ok ? [] : r.errors;
};

describe('validador 1: esquema', () => {
  it('acepta una salida correcta', () => {
    expect(validateTurnOutput(base(), ctx).ok).toBe(true);
  });
  it('rechaza intención desconocida, campos extra o faltantes', () => {
    expect(errorsOf({ ...base(), intent: 'COMPRA' })[0]).toMatch(/esquema/);
    expect(errorsOf({ ...base(), precio: 1 })[0]).toMatch(/esquema/);
    const { reply: _r, ...noReply } = base();
    expect(errorsOf(noReply)[0]).toMatch(/esquema/);
    expect(errorsOf('texto plano')[0]).toMatch(/esquema/);
  });
});

describe('validador 2: cifras prohibidas', () => {
  it.each([
    'Te queda en $30.000 al mes',
    'Incluye 100 GB',
    'Tienes un 20% menos',
    'Son cincuenta megas',
    'Vale 39900',
    'Hasta el 15/11',
  ])('rechaza: %s', (reply) => {
    expect(errorsOf(base({ reply })).some((e) => e.startsWith('cifras'))).toBe(true);
  });

  it('permite cifras dentro de marcadores (las pone el código)', () => {
    expect(errorsOf(base({ reply: 'Te recomiendo este:\n{{OFERTA:P2}}' }))).toEqual([]);
  });
});

describe('validador 3: catálogo', () => {
  it('rechaza un plan inexistente o de otro proceso', () => {
    expect(errorsOf(base({ reply: 'Mira {{OFERTA:X9}}' }))).toContainEqual(
      expect.stringMatching(/catálogo: el plan X9/),
    );
    expect(errorsOf(base({ intent: 'ACEPTA_PLAN', planCode: 'M1' }))).toContainEqual(
      expect.stringMatching(/catálogo: el plan M1/),
    );
  });
  it('ACEPTA_PLAN exige planCode', () => {
    expect(errorsOf(base({ intent: 'ACEPTA_PLAN' }))).toContainEqual(
      expect.stringMatching(/requiere planCode/),
    );
  });
  it('no permite ofrecer planes en AUTORIZACION ni marcadores ajenos', () => {
    expect(
      errorsOf(base({ reply: '{{OFERTA:P1}}' }), { ...ctx, stage: 'AUTORIZACION' }).length,
    ).toBeGreaterThan(0);
    expect(errorsOf(base({ reply: 'Ok {{AUTORIZACION}}' }))).toContainEqual(
      expect.stringMatching(/marcadores no permitidos/),
    );
  });
});

describe('validador 4: promesas prohibidas', () => {
  it.each([
    'Te lo dejo gratis',
    'Es sin costo',
    'Cobertura garantizada',
    'Te regalo un mes',
    'Datos ilimitados',
    'Tienes un descuento especial',
  ])('rechaza: %s', (reply) => {
    expect(errorsOf(base({ reply })).some((e) => e.startsWith('promesa'))).toBe(true);
  });
});

describe('validador 5: transición', () => {
  it('rechaza AUTORIZA fuera de AUTORIZACION', () => {
    expect(errorsOf(base({ intent: 'AUTORIZA' }))).toContainEqual(
      expect.stringMatching(/no permitida en OFERTA/),
    );
  });
  it('ELIGE_OPCION exige la opción', () => {
    expect(errorsOf(base({ intent: 'ELIGE_OPCION' }), { ...ctx, stage: 'MENU' })).toContainEqual(
      expect.stringMatching(/requiere option/),
    );
  });
});

describe('validador 6: longitud y formato', () => {
  it('rechaza textos largos, Markdown y enlaces', () => {
    expect(errorsOf(base({ reply: 'a'.repeat(650) }))).not.toEqual([]);
    expect(errorsOf(base({ reply: 'Esto es **importante**' }))).toContainEqual(
      expect.stringMatching(/formato/),
    );
    expect(errorsOf(base({ reply: 'Mira en https://ejemplo.test' }))).toContainEqual(
      expect.stringMatching(/enlaces/),
    );
  });
  it('acepta *negrita* de WhatsApp y saltos de línea', () => {
    expect(errorsOf(base({ reply: '*Perfecto*, Ana.\n¿Qué usas más?' }))).toEqual([]);
  });
});
