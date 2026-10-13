import { describe, expect, it } from 'vitest';
import { parsePlanImageCards, readBrainExport } from './brain-export.js';

const ok = {
  formato: 'abaya-brain',
  version: 1,
  nombre: 'Planes Agosto',
  fuentes: [
    {
      kind: 'FILE',
      use: 'IMAGE',
      name: 'todos.png',
      mime: 'image/png',
      metadata: { procesos: 'PORTABILIDAD', descuento_PORTABILIDAD: 'Descuento 20%' },
      data: 'iVBORw0KGgo=',
      cards: [{ code: '37230', dataText: 'GB ILIMITADAS', priceCop: 99900, callsText: null }],
    },
    {
      kind: 'TEXT',
      use: 'FULL_CONTEXT',
      name: 'FAQ',
      mime: 'text/markdown',
      metadata: null,
      text: 'Hola',
    },
    {
      kind: 'WEB',
      use: 'SEARCH',
      name: 'web',
      mime: null,
      metadata: null,
      url: 'https://x.co',
      refreshHours: 24,
    },
  ],
};

describe('D-019: exportar e importar un Brain', () => {
  it('reconoce el archivo y cada tipo de fuente', () => {
    const r = readBrainExport(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fuentes.map((f) => f.kind)).toEqual(['FILE', 'TEXT', 'WEB']);
    expect(r.value.fuentes[0]!.cards).toEqual([
      { code: '37230', dataText: 'GB ILIMITADAS', priceCop: 99900 },
    ]);
    expect(r.value.fuentes[0]!.metadata).toMatchObject({ descuento_PORTABILIDAD: 'Descuento 20%' });
  });

  it('rechaza archivos ajenos o fuentes incompletas', () => {
    expect(readBrainExport({ ...ok, formato: 'abaya-agente' }).ok).toBe(false);
    expect(readBrainExport({ ...ok, nombre: '' }).ok).toBe(false);
    const sinTarjetas = { ...ok, fuentes: [{ ...ok.fuentes[0], cards: undefined }] };
    expect(readBrainExport(sinTarjetas)).toMatchObject({
      ok: false,
      error: expect.stringContaining('fuente 1'),
    });
    const sinUrl = { ...ok, fuentes: [{ ...ok.fuentes[2], url: '' }] };
    expect(readBrainExport(sinUrl).ok).toBe(false);
  });

  it('lo leído de las tarjetas se revisa campo por campo', () => {
    expect(parsePlanImageCards([{ code: null, dataText: '10 GB', priceCop: 39900 }])).toEqual([
      { code: null, dataText: '10 GB', priceCop: 39900 },
    ]);
    expect(parsePlanImageCards([{ code: 1, dataText: '10 GB', priceCop: 39900 }])).toBeNull();
    expect(parsePlanImageCards([{ code: null, dataText: '10 GB', priceCop: -5 }])).toBeNull();
    expect(parsePlanImageCards('x')).toBeNull();
  });
});
