import { describe, expect, it } from 'vitest';
import { toPlan } from '../catalog/catalog.js';
import { globalChecks } from './suite.js';

const plan = toPlan({
  process: 'PORTABILIDAD',
  code: 'P1',
  name: 'Plan GB ilimitadas',
  dataText: 'GB ilimitadas',
  sharedDataText: null,
  includesText: null,
  extrasText: null,
  unlimitedAppsText: null,
  callsText: null,
  priceCop: 99_900,
  discountText: '20% de descuento en el cargo fijo mensual durante los primeros 5 meses',
});
const bot = (text: string) => [{ role: 'bot' as const, text }];
const check = (text: string) =>
  globalChecks(
    bot(text),
    false,
    new Date('2026-10-08T15:00:00Z'),
    [plan],
    undefined,
    'PORTABILIDAD',
  );

describe('suite: detector de cifras inventadas', () => {
  it('acepta el precio con descuento que calcula el sistema', () => {
    expect(check('Con el descuento pagas $79.920 al mes y después $99.900.')).toEqual([]);
  });

  it('sigue rechazando un precio que no sale del catálogo', () => {
    expect(check('Te queda en $79.000 al mes.')).toContain(
      'INVENTADO: precio $79.000 no está en el catálogo de PORTABILIDAD',
    );
  });
});
