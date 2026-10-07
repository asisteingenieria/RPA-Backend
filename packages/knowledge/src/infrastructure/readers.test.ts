import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { formatIssue, validateCatalog } from '../domain/catalog.js';
import { detectFile, FileRejected } from './file-detection.js';
import { excelCell, readCsv, readXlsx } from './table-parser.js';

const HEADER =
  'Proceso;ID;Datos;GB para compartir;Incluye;Servicios adicionales;Apps ilimitadas;Llamadas y mensajes;Precio;Descuento';

async function xlsx(
  build: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet('Planes'), wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('detectFile: tipo real por contenido', () => {
  it('acepta un XLSX de verdad', async () => {
    const bytes = await xlsx((ws) => ws.addRow(['a']));
    await expect(detectFile(bytes, 'planes.xlsx', ['xlsx', 'csv'])).resolves.toMatchObject({
      kind: 'xlsx',
    });
  });

  it('rechaza un CSV renombrado a .xlsx', async () => {
    const bytes = new TextEncoder().encode(`${HEADER}\n`);
    await expect(detectFile(bytes, 'planes.xlsx', ['xlsx', 'csv'])).rejects.toThrow(
      'no es un .xlsx válido',
    );
  });

  it('rechaza un XLSX renombrado a .csv', async () => {
    const bytes = await xlsx((ws) => ws.addRow(['a']));
    await expect(detectFile(bytes, 'planes.csv', ['xlsx', 'csv'])).rejects.toThrow('no es texto');
  });

  it('rechaza extensiones no permitidas para el uso', async () => {
    await expect(
      detectFile(new Uint8Array([1]), 'planes.pdf', ['xlsx', 'csv']),
    ).rejects.toBeInstanceOf(FileRejected);
    await expect(detectFile(new Uint8Array([1]), 'planes.exe', ['xlsx', 'csv'])).rejects.toThrow(
      'no permitido',
    );
  });

  it('rechaza binarios sin firma conocida con extensión de texto', async () => {
    await expect(detectFile(new Uint8Array([65, 0, 66]), 'planes.csv', ['csv'])).rejects.toThrow(
      'bytes nulos',
    );
  });

  it('CSV en Windows-1252 (como lo guarda Excel): se lee con aviso', async () => {
    const latin1 = Uint8Array.from([...'Migraci'].map((c) => c.charCodeAt(0)).concat([0xf3, 0x6e]));
    const r = await detectFile(latin1, 'planes.csv', ['csv']);
    expect(r.warnings[0]).toContain('Windows-1252');
  });
});

describe('readCsv', () => {
  it('detecta ";" como separador, quita el BOM y numera las filas del archivo', () => {
    const text = `\uFEFF${HEADER}\nPortabilidad;P1;40 GB;;"Redes; WhatsApp";;;;$ 59.900;\n\nMigración;M1;20 GB;;;;;;45900;\n`;
    const { table } = readCsv(new TextEncoder().encode(text));
    const v = validateCatalog(table);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.records.map((r) => [r.code, r.priceCop, r.includesText])).toEqual([
      ['P1', 59900, 'Redes; WhatsApp'],
      ['M1', 45900, null],
    ]);
  });

  it('los errores llevan la fila real del archivo', () => {
    const text = `${HEADER}\nPortabilidad;P1;40 GB;;;;;;59900;\nPrepago;P2;40 GB;;;;;;59900;\n`;
    const v = validateCatalog(readCsv(new TextEncoder().encode(text)).table);
    expect(!v.ok && v.errors.map(formatIssue)).toEqual([
      'Fila 3, Proceso: proceso desconocido «Prepago» (usa Portabilidad, Migración o Línea nueva)',
    ]);
  });

  it('CSV mal formado', () => {
    expect(() => readCsv(new TextEncoder().encode(`${HEADER}\n"abierto;P1\n`))).toThrow(
      FileRejected,
    );
  });
});

describe('readXlsx', () => {
  it('lee fórmulas por su resultado, texto enriquecido y la hoja "Planes"', async () => {
    const bytes = await xlsx((ws, wb) => {
      wb.addWorksheet('Notas').addRow(['no es esta']);
      ws.addRow(HEADER.split(';'));
      ws.addRow([
        'Portabilidad',
        'P1',
        { richText: [{ text: '40 ' }, { text: 'GB', font: { bold: true } }] },
        null,
        null,
        null,
        null,
        null,
        { formula: '50000+9900', result: 59900 },
        null,
      ]);
    });
    const { table, warnings } = await readXlsx(bytes);
    expect(warnings[0]).toContain('se leyó «Planes»');
    const v = validateCatalog(table);
    expect(v.ok && v.records[0]).toMatchObject({ code: 'P1', dataText: '40 GB', priceCop: 59900 });
  });

  it('un Excel dañado se rechaza con un mensaje claro', async () => {
    await expect(readXlsx(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]))).rejects.toThrow(
      'no se pudo leer el Excel',
    );
  });

  it('excelCell: errores y fórmulas sin resultado', () => {
    expect(excelCell({ error: '#REF!' })).toEqual({ error: '#REF!' });
    expect(excelCell({ formula: 'A1' })).toEqual({ error: 'fórmula sin resultado' });
    expect(excelCell({ text: 'web', hyperlink: 'https://x' })).toBe('web');
  });
});
