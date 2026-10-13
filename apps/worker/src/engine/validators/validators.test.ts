import { describe, expect, it } from 'vitest';
import type { Plan } from '../../catalog/catalog.js';
import type { TurnOutput } from '../output-schema.js';
import { validateTurnOutput, type ValidationContext } from './validators.js';
import { discountedPriceCop, unverifiedFigures } from './figures.js';
import * as T from '../templates/templates.js';

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
    'Te lo dejo en treinta mil pesos',
    'Vale 49900',
    'Incluye 10 GB por $49.900',
    'Hasta el 15/11',
  ])('rechaza: %s', (reply) => {
    expect(errorsOf(base({ reply })).some((e) => e.startsWith('cifras'))).toBe(true);
  });

  // D-007: las cifras copiadas del catálogo del proceso (o del guion publicado) sí pasan.
  it.each(['Incluye *10 GB* por *$39.900* al mes', 'Vale 39900', 'Son 10GB y cuesta $ 39.900'])(
    'acepta cifras del catálogo: %s',
    (reply) => {
      expect(errorsOf(base({ reply }))).toEqual([]);
    },
  );

  it('acepta números del guion publicado (líneas de atención, leyes, 5G)', () => {
    const reply = 'Llama al *611 o al 018003200200. Tenemos 5G.';
    expect(errorsOf(base({ reply }))).not.toEqual([]);
    const guion = 'Canales: *611 y 018003200200. Cobertura 5G.';
    expect(errorsOf(base({ reply }), { ...ctx, approvedTexts: [guion] })).toEqual([]);
  });

  it('un precio de otro proceso no pasa aunque exista en el catálogo', () => {
    const otro = { ...plan('M1', 'MIGRACION'), priceCop: 29900 };
    expect(errorsOf(base({ reply: 'Cuesta $29.900' }))).not.toEqual([]);
    expect(errorsOf(base({ reply: 'Cuesta $29.900' }), { ...ctx, availablePlans: [otro] })).toEqual(
      [],
    );
  });

  it('acepta el descuento redactado con naturalidad si las cifras coinciden', () => {
    const p = { ...plan('P1'), discountText: '20% CFM en mes 1, 2, 3, 4 y 5' };
    const c = { ...ctx, availablePlans: [p] };
    const reply = 'Tienes *20% de descuento* en tu cargo fijo los primeros 5 meses 🎉';
    expect(errorsOf(base({ reply }), c)).toEqual([]);
    expect(
      errorsOf(base({ reply: 'Tienes 25% de descuento los primeros 5 meses' }), c),
    ).not.toEqual([]);
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

describe('validador 3a: ofrecer con imágenes (D-014)', () => {
  const images: ValidationContext = { ...ctx, imagesMode: true, videoImages: true };
  it('en modo imágenes acepta {{IMAGENES}} y rechaza las fichas de texto', () => {
    expect(errorsOf(base({ reply: '¡Mira esta opción! {{IMAGENES}}' }), images)).toEqual([]);
    expect(errorsOf(base({ reply: '{{IMAGENES}}' }), images)).toEqual([]);
    expect(errorsOf(base({ reply: 'Mira: {{OFERTA:P1}}' }), images)[0]).toMatch(
      /se ofrecen con \{\{IMAGENES\}\}/,
    );
  });
  it('no envía imágenes fuera de las etapas de oferta ni una circular de video que no existe', () => {
    expect(errorsOf(base({ reply: '{{IMAGENES}}' }), { ...images, stage: 'MENU' })[0]).toMatch(
      /imágenes de planes en este estado/,
    );
    expect(
      errorsOf(base({ reply: 'Mira {{IMAGENES_VIDEO}}' }), { ...images, videoImages: false })[0],
    ).toMatch(/no hay imagen de apps de video/);
  });
  it('fuera del modo imágenes, {{IMAGENES}} no existe', () => {
    expect(errorsOf(base({ reply: 'Mira {{IMAGENES}}' }))[0]).toMatch(/marcadores no permitidos/);
  });
});

describe('validador 3b: {{DETALLE}} de un plan', () => {
  it('acepta el detalle de un plan del proceso, uno por mensaje, después de la oferta', () => {
    expect(errorsOf(base({ reply: 'Te cuento: {{DETALLE:P1}}' }))).toEqual([]);
    expect(errorsOf(base({ reply: '{{DETALLE:P9}}' }))[0]).toMatch(/P9 no existe/);
    expect(errorsOf(base({ reply: '{{DETALLE:P1}} {{DETALLE:P2}}' }))[0]).toMatch(/un solo/);
    expect(errorsOf(base({ reply: '{{DETALLE:P1}}' }), { ...ctx, stage: 'PERFIL' })[0]).toMatch(
      /ya vio la oferta/,
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
    expect(errorsOf(base({ reply: 'a'.repeat(1_250) }))).not.toEqual([]);
    // D-007: las **negritas** se convierten a WhatsApp al enviar; los títulos no.
    expect(errorsOf(base({ reply: 'Esto es **importante**' }))).toEqual([]);
    expect(errorsOf(base({ reply: '## Planes\nEste' }))).toContainEqual(
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

describe('precio con descuento calculado por el código', () => {
  const conDescuento = {
    ...plan('P9'),
    priceCop: 99900,
    discountText: '20% CFM en mes 1, 2, 3, 4 y 5',
  };
  const src = { plans: [conDescuento], approvedTexts: [] };

  it('calcula el precio con un único porcentaje sobre el plan', () => {
    expect(discountedPriceCop(conDescuento)).toBe(79920);
    expect(discountedPriceCop({ ...conDescuento, discountText: null })).toBeNull();
    // Dos porcentajes o un descuento que no es del plan: no se adivina.
    expect(
      discountedPriceCop({ ...conDescuento, discountText: '20% mes 1 y 10% mes 2' }),
    ).toBeNull();
    expect(discountedPriceCop({ ...conDescuento, discountText: '30% en el equipo' })).toBeNull();
  });

  it('el validador acepta el precio con descuento y sigue rechazando otros', () => {
    expect(unverifiedFigures('Con el descuento pagas $79.920 al mes', src)).toEqual([]);
    expect(unverifiedFigures('Te queda en $79.000 al mes', src)).toHaveLength(1);
  });

  it('la ficha oficial muestra el precio con descuento', () => {
    expect(T.offer(conDescuento)).toContain('Con el descuento pagas *$79.920* al mes');
    expect(T.offer({ ...conDescuento, discountText: null })).not.toContain('Con el descuento');
  });
});
