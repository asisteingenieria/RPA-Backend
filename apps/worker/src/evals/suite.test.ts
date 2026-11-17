import { DEFAULT_AGENT_CONFIG, LlmProviderError, type LlmRequest } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import { readCatalogFile, SYNTHETIC_CATALOG, toPlan } from '../catalog/catalog.js';
import { heuristicBrain } from '../llm/adapters/heuristic-brain.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';
import * as T from '../engine/templates/templates.js';
import { globalChecks, runCase, type EvalCase } from './suite.js';

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

describe('suite: plantillas del sistema con el nombre del cliente', () => {
  it('D-044: la segunda lectura cita la ley y no cuenta como cifra inventada', () => {
    const now = new Date('2026-10-08T15:00:00Z');
    const text = T.systemText(DEFAULT_AGENT_CONFIG, 'SEGUNDA_LECTURA', 'Mónica', now);
    expect(text).toContain('1581');
    expect(globalChecks(bot(text), false, now, [plan], DEFAULT_AGENT_CONFIG, 'MIGRACION')).toEqual(
      [],
    );
  });
});

describe('suite: caídas del proveedor (D-009)', () => {
  const c: EvalCase = {
    id: 'caida-01',
    group: 'pruebas',
    turns: ['Hola', 'B', 'Mónica'],
    expect: { finalStage: 'OFERTA' },
  };

  it('reintenta el turno: el mensaje no se junta con el siguiente', async () => {
    const plans = await readCatalogFile(SYNTHETIC_CATALOG);
    let calls = 0;
    const heuristic = new ScriptedLlmAdapter(heuristicBrain);
    const llm = {
      provider: 'prueba',
      complete: (req: LlmRequest) => {
        if (++calls === 1) throw new LlmProviderError('sin respuesta', 'prueba', true);
        return heuristic.complete(req);
      },
    };
    const r = await runCase(c, { provider: 'prueba', llm: () => llm, plans, outageRetryMs: 0 });
    expect(r.outages).toBe(1);
    expect(r.failures).toEqual([]);
    // Cada mensaje del cliente tuvo su respuesta.
    expect(r.transcript.map((m) => m.role)).toEqual([
      'cliente',
      'bot',
      'cliente',
      'bot',
      'cliente',
      'bot',
    ]);
  });

  it('si el proveedor nunca responde, el caso falla por el proveedor', async () => {
    const plans = await readCatalogFile(SYNTHETIC_CATALOG);
    const llm = {
      provider: 'prueba',
      complete: () => Promise.reject(new LlmProviderError('sin respuesta', 'prueba', true)),
    };
    const r = await runCase(c, { provider: 'prueba', llm: () => llm, plans, outageRetryMs: 0 });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.startsWith('PROVEEDOR:'))).toBe(true);
  });
});
