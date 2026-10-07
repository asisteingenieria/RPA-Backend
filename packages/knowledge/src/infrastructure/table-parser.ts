import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import {
  normalizeLabel,
  type CellValue,
  type TableData,
  type TableRow,
} from '../domain/catalog.js';
import type { TableParser } from '../domain/ports.js';
import { decodeText, FileRejected } from './file-detection.js';

/** Hoja preferida dentro del Excel; si no existe, la primera. */
const PREFERRED_SHEET = 'planes';

/**
 * Lee la tabla del catálogo desde XLSX (ExcelJS) o CSV (csv-parse). Solo convierte celdas a
 * texto o número; la validación del esquema es del dominio (`validateCatalog`).
 */
export class CatalogTableParser implements TableParser {
  async parse(bytes: Uint8Array, kind: 'xlsx' | 'csv') {
    return kind === 'xlsx' ? readXlsx(bytes) : readCsv(bytes);
  }
}

export async function readXlsx(
  bytes: Uint8Array,
): Promise<{ table: TableData; warnings: string[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  } catch {
    throw new FileRejected('no se pudo leer el Excel (¿está dañado o protegido con contraseña?)');
  }
  const sheets = wb.worksheets;
  if (!sheets.length) throw new FileRejected('el Excel no tiene hojas');
  const ws = sheets.find((s) => normalizeLabel(s.name) === PREFERRED_SHEET) ?? sheets[0]!;
  const warnings =
    sheets.length > 1 ? [`el Excel tiene ${sheets.length} hojas: se leyó «${ws.name}»`] : [];

  const lines: TableRow[] = [];
  const width = ws.columnCount;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: CellValue[] = [];
    for (let c = 1; c <= width; c++) cells.push(excelCell(row.getCell(c).value));
    lines.push({ line: r, cells });
  }
  return { table: toTable(lines), warnings };
}

/** Valor de una celda de ExcelJS → texto, número, vacío o error. */
export function excelCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { error: String(v) };
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o) return { error: String(o.error) };
    if (Array.isArray(o.richText)) {
      return (o.richText as { text?: unknown }[]).map((t) => String(t.text ?? '')).join('');
    }
    if ('formula' in o || 'sharedFormula' in o) {
      return o.result === undefined ? { error: 'fórmula sin resultado' } : excelCell(o.result);
    }
    if ('hyperlink' in o) return excelCell(o.text);
    if ('text' in o) return excelCell(o.text);
  }
  return { error: 'tipo de celda no soportado' };
}

export function readCsv(bytes: Uint8Array): { table: TableData; warnings: string[] } {
  const { text, warnings } = decodeText(bytes);
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  // Excel en español guarda el CSV con ";". Se elige por el encabezado.
  const delimiter = count(firstLine, ';') > count(firstLine, ',') ? ';' : ',';
  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parseCsv(text, {
      bom: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: false,
      info: true,
    }) as unknown as { record: string[]; info: { lines: number } }[];
  } catch (err) {
    const where = (err as { lines?: number }).lines;
    throw new FileRejected(`CSV mal formado${where ? ` cerca de la fila ${where}` : ''}`);
  }
  return {
    table: toTable(records.map((r) => ({ line: r.info.lines, cells: r.record }))),
    warnings,
  };
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** El encabezado es la primera fila con algún valor. */
function toTable(lines: TableRow[]): TableData {
  const isEmpty = (r: TableRow) =>
    r.cells.every((c) => c === null || (typeof c === 'string' && !c.trim()));
  const h = lines.findIndex((r) => !isEmpty(r));
  if (h < 0) throw new FileRejected('el archivo está vacío');
  return { headers: lines[h]!.cells, headerLine: lines[h]!.line, rows: lines.slice(h + 1) };
}
