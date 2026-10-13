import { describe, expect, it } from 'vitest';
import type { CatalogRecordData } from './catalog.js';
import {
  checkPlanImages,
  dataKey,
  diffImages,
  isEmptyImageDiff,
  matchImageCards,
  parseImageDiscounts,
  parseImageProcesses,
  recordsFromImages,
  parseVideoAppsFlag,
} from './images.js';

const rec = (
  process: CatalogRecordData['process'],
  code: string,
  dataText: string,
  priceCop: number,
): CatalogRecordData => ({
  process,
  code,
  name: null,
  dataText,
  sharedDataText: null,
  includesText: null,
  extrasText: null,
  unlimitedAppsText: null,
  callsText: null,
  priceCop,
  discountText: null,
});

const records = [
  rec('PORTABILIDAD', 'P2', '65 GB', 56_900),
  rec('PORTABILIDAD', 'P1', 'GB ilimitadas', 99_900),
  rec('MIGRACION', '38081', '65 GB', 53_900),
];

describe('imágenes de planes (D-011)', () => {
  it('normaliza los datos para comparar', () => {
    expect(dataKey('65 GB')).toBe('65gb');
    expect(dataKey('65GB')).toBe('65gb');
    expect(dataKey('GB ILIMITADAS')).toBe('ilimitadas');
    expect(dataKey('Gigas ilimitadas')).toBe('ilimitadas');
  });

  it('lee la lista de procesos sin repetidos ni valores inválidos', () => {
    expect(parseImageProcesses('migracion, PORTABILIDAD,otro,PORTABILIDAD')).toEqual([
      'PORTABILIDAD',
      'MIGRACION',
    ]);
    expect(parseImageProcesses(undefined)).toEqual([]);
  });

  it('empareja por GB y precio, o por el código impreso', () => {
    const m = matchImageCards(
      [
        { code: '38327', dataText: '65 GB', priceCop: 56_900 },
        { code: null, dataText: 'GB ILIMITADAS', priceCop: 99_900 },
      ],
      records,
      'PORTABILIDAD',
    );
    expect(m.map((x) => x.code)).toEqual(['P2', 'P1']);
    expect(m.every((x) => x.problem === null)).toBe(true);

    const byCode = matchImageCards(
      [{ code: '38081', dataText: '65 GB', priceCop: 53_900 }],
      records,
      'MIGRACION',
    );
    expect(byCode[0]!.code).toBe('38081');
  });

  it('rechaza un plan que no está en el catálogo del proceso o con otro precio', () => {
    const [missing] = matchImageCards(
      [{ code: null, dataText: '130 GB', priceCop: 75_900 }],
      records,
      'PORTABILIDAD',
    );
    expect(missing!.problem).toBe(
      'el plan 130 GB · $75.900 no está en el catálogo de Portabilidad',
    );

    const [wrongPrice] = matchImageCards(
      [{ code: '38081', dataText: '65 GB', priceCop: 56_900 }],
      records,
      'MIGRACION',
    );
    expect(wrongPrice!.code).toBeNull();
    expect(wrongPrice!.problem).toContain('precio $56.900 y el catálogo dice $53.900');
  });

  it('valida cada imagen en cada proceso al que pertenece', () => {
    const r = checkPlanImages(
      [
        {
          sourceName: 'planes.jpeg',
          processes: ['PORTABILIDAD', 'MIGRACION'],
          cards: [{ code: null, dataText: '65 GB', priceCop: 56_900 }],
        },
      ],
      records,
    );
    expect(r.images[0]!.codes).toEqual({ PORTABILIDAD: ['P2'], MIGRACION: [] });
    expect(r.problems).toEqual([
      'Imagen «planes.jpeg»: el plan 65 GB · $56.900 no está en el catálogo de Migración',
    ]);
  });

  it('una imagen sin planes leídos o un Brain sin catálogo no se pueden publicar', () => {
    expect(
      checkPlanImages([{ sourceName: 'x.png', processes: ['PORTABILIDAD'], cards: [] }], records)
        .problems,
    ).toEqual(['Imagen «x.png»: no se leyó ningún plan en la imagen']);
    expect(
      checkPlanImages(
        [
          {
            sourceName: 'x.png',
            processes: ['PORTABILIDAD'],
            cards: [{ code: null, dataText: '65 GB', priceCop: 56_900 }],
          },
        ],
        [],
      ).problems,
    ).toEqual(['Imagen «x.png»: el Brain no tiene catálogo de planes']);
  });

  it('limita las imágenes por proceso', () => {
    const img = (n: number) => ({
      sourceName: `${n}.png`,
      processes: ['PORTABILIDAD' as const],
      cards: [{ code: null, dataText: '65 GB', priceCop: 56_900 }],
    });
    const r = checkPlanImages([1, 2, 3, 4, 5, 6].map(img), records);
    expect(r.problems).toEqual(['Portabilidad tiene 6 imágenes: el máximo es 5']);
  });

  it('diferencias por nombre, archivo y procesos', () => {
    const a = { sourceName: 'a.png', sourceHash: 'h1', processes: ['PORTABILIDAD' as const] };
    const b = { sourceName: 'b.png', sourceHash: 'h2', processes: ['MIGRACION' as const] };
    expect(isEmptyImageDiff(diffImages([a, b], [b, a]))).toBe(true);
    const d = diffImages([a, b], [{ ...a, processes: ['PORTABILIDAD', 'MIGRACION'] }]);
    expect(d.changed.map((x) => x.source)).toEqual(['a.png']);
    expect(d.removed.map((x) => x.source)).toEqual(['b.png']);
    expect(d.added).toEqual([]);
  });
});

describe('D-014: marca de apps de video', () => {
  it('acepta true, «true», «1» y «sí»; lo demás no', () => {
    for (const v of [true, 'true', '1', 'si', 'Sí', ' TRUE '])
      expect(parseVideoAppsFlag(v)).toBe(true);
    for (const v of [false, 'false', '', '0', 'no', undefined, null, 1])
      expect(parseVideoAppsFlag(v)).toBe(false);
  });
});

describe('D-016: descuento de los planes de una imagen, por proceso', () => {
  const card = (code: string, dataText: string, priceCop: number) => ({ code, dataText, priceCop });
  const COMENTARIO =
    '✅Descuento del 25% en la 1 y 2 facturación\n✅Descuento del 20% en la 1,2,3,4 y 5 facturación';

  it('el comentario del proceso es el Descuento de cada plan de la imagen en ese proceso', () => {
    const records = recordsFromImages([
      {
        processes: ['PORTABILIDAD', 'MIGRACION'],
        cards: [card('37230', 'GB ILIMITADAS', 99_900), card('38362', '130 GB', 75_900)],
        discounts: { PORTABILIDAD: COMENTARIO },
      },
    ]);
    const by = (code: string) => records.find((r) => r.code === code)!;
    expect(by('P37230').discountText).toBe(COMENTARIO);
    expect(by('P38362').discountText).toBe(COMENTARIO);
    // En Migración no se escribió descuento: esos planes no lo tienen.
    expect(by('M37230').discountText).toBeNull();
  });

  it('sin comentario, los planes de las imágenes no tienen descuento (como antes)', () => {
    const [r] = recordsFromImages([
      { processes: ['LINEA_NUEVA'], cards: [card('38081', '65 GB', 53_900)] },
    ]);
    expect(r!.discountText).toBeNull();
  });

  it('lee el metadato de la fuente: solo los procesos pedidos, sin vacíos, saltos de línea normalizados', () => {
    const meta = {
      procesos: 'PORTABILIDAD,MIGRACION',
      descuento_PORTABILIDAD: '  ✅25% en la 1 y 2\r\n✅20% en la 1 a 5  ',
      descuento_MIGRACION: '   ',
      descuento_LINEA_NUEVA: 'no es de esta imagen',
    };
    expect(parseImageDiscounts(meta, ['PORTABILIDAD', 'MIGRACION'])).toEqual({
      PORTABILIDAD: '✅25% en la 1 y 2\n✅20% en la 1 a 5',
    });
    expect(parseImageDiscounts(null)).toEqual({});
  });
});
