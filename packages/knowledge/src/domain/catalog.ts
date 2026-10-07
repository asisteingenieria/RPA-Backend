import { canonicalJson, sha256 } from '@abaya/crypto';
import { instructionLikeWarning } from './injection.js';

/**
 * Catálogo estructurado de un Brain (v1.9, docs/DECISIONS.md D-001 §4). Se carga desde
 * Excel/CSV, se valida contra este esquema y se guarda como REGISTROS (no como texto). Precios
 * y textos se devuelven literalmente: el modelo nunca los reconstruye (regla 11).
 */

export const SALE_PROCESSES = ['PORTABILIDAD', 'MIGRACION', 'LINEA_NUEVA'] as const;
export type SaleProcess = (typeof SALE_PROCESSES)[number];

export const PROCESS_LABEL: Record<SaleProcess, string> = {
  PORTABILIDAD: 'Portabilidad',
  MIGRACION: 'Migración',
  LINEA_NUEVA: 'Línea nueva',
};

export interface CatalogRecordData {
  process: SaleProcess;
  /** Columna "ID": el código que el guion cita con {{OFERTA:CÓDIGO}}. */
  code: string;
  /** Columna opcional "Nombre"; sin ella la ficha usa "Plan {ID}". */
  name: string | null;
  dataText: string;
  sharedDataText: string | null;
  includesText: string | null;
  extrasText: string | null;
  unlimitedAppsText: string | null;
  callsText: string | null;
  /** Pesos colombianos, entero. */
  priceCop: number;
  discountText: string | null;
}

type Kind = 'process' | 'code' | 'text' | 'price';

interface ColumnSpec {
  key: keyof CatalogRecordData;
  header: string;
  kind: Kind;
  /** La celda no puede ir vacía. */
  required: boolean;
  /** La columna puede no existir en el archivo. */
  optionalColumn?: boolean;
  maxLength?: number;
}

export const CATALOG_COLUMNS: readonly ColumnSpec[] = [
  { key: 'process', header: 'Proceso', kind: 'process', required: true },
  { key: 'code', header: 'ID', kind: 'code', required: true },
  {
    key: 'name',
    header: 'Nombre',
    kind: 'text',
    required: false,
    optionalColumn: true,
    maxLength: 80,
  },
  { key: 'dataText', header: 'Datos', kind: 'text', required: true, maxLength: 120 },
  {
    key: 'sharedDataText',
    header: 'GB para compartir',
    kind: 'text',
    required: false,
    maxLength: 120,
  },
  { key: 'includesText', header: 'Incluye', kind: 'text', required: false, maxLength: 300 },
  {
    key: 'extrasText',
    header: 'Servicios adicionales',
    kind: 'text',
    required: false,
    maxLength: 300,
  },
  {
    key: 'unlimitedAppsText',
    header: 'Apps ilimitadas',
    kind: 'text',
    required: false,
    maxLength: 300,
  },
  {
    key: 'callsText',
    header: 'Llamadas y mensajes',
    kind: 'text',
    required: false,
    maxLength: 300,
  },
  { key: 'priceCop', header: 'Precio', kind: 'price', required: true },
  { key: 'discountText', header: 'Descuento', kind: 'text', required: false, maxLength: 300 },
];

/** Etiqueta en la ficha de WhatsApp de cada columna de texto (en el orden del archivo). */
export const FEATURE_FIELDS = [
  ['dataText', 'Datos'],
  ['sharedDataText', 'GB para compartir'],
  ['includesText', 'Incluye'],
  ['extrasText', 'Servicios adicionales'],
  ['unlimitedAppsText', 'Apps ilimitadas'],
  ['callsText', 'Llamadas y mensajes'],
] as const satisfies readonly (readonly [keyof CatalogRecordData, string])[];

export const CATALOG_LIMITS = {
  maxRows: 500,
  maxPriceCop: 5_000_000,
  /** Formato que exigen los marcadores {{OFERTA:CÓDIGO}} del motor. */
  codePattern: /^[A-Z][A-Z0-9]{0,9}$/,
} as const;

/** Celda leída del archivo. `{ error }` = celda de Excel con error (#N/A, #REF!…). */
export type CellValue = string | number | null | { error: string };

export interface TableRow {
  /** Número de fila en el archivo (1 = primera fila), para los mensajes. */
  line: number;
  cells: CellValue[];
}

export interface TableData {
  headers: CellValue[];
  /** Fila del encabezado en el archivo. */
  headerLine: number;
  rows: TableRow[];
}

export interface CatalogIssue {
  row?: number;
  column?: string;
  message: string;
}

export type CatalogValidation =
  | { ok: true; records: CatalogRecordData[]; warnings: CatalogIssue[] }
  | { ok: false; errors: CatalogIssue[]; warnings: CatalogIssue[] };

const MAX_REPORTED_ERRORS = 50;

/** Minúsculas, sin tildes y con espacios simples: "  Línea  Nueva" → "linea nueva". */
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();
}

const PROCESS_BY_LABEL: Record<string, SaleProcess> = {
  portabilidad: 'PORTABILIDAD',
  migracion: 'MIGRACION',
  'linea nueva': 'LINEA_NUEVA',
};

export function parseProcess(v: string): SaleProcess | undefined {
  return PROCESS_BY_LABEL[normalizeLabel(v)];
}

/**
 * Precio en pesos: entero positivo. Acepta `99900`, `99.900`, `$ 99.900` y `99.900 COP`.
 * Rechaza decimales, comas (ambiguas: ¿miles o decimales?), negativos y texto.
 */
export function parsePriceCop(
  v: CellValue,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (v === null || (typeof v === 'string' && !v.trim())) return { ok: false, reason: 'vacío' };
  if (typeof v === 'object') return { ok: false, reason: `celda con error ${v.error}` };
  let n: number;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return { ok: false, reason: `«${v}» tiene decimales` };
    n = v;
  } else {
    const s = v.replace(/\s+/g, '').replace(/^\$/, '').replace(/COP$/i, '');
    if (/,/.test(s)) {
      return {
        ok: false,
        reason: `«${v}» usa coma; escribe el precio sin decimales, p. ej. 99.900`,
      };
    }
    if (!/^(\d{1,3}(\.\d{3})+|\d+)$/.test(s)) {
      return { ok: false, reason: `«${v}» no es un precio válido (p. ej. 99900 o $ 99.900)` };
    }
    n = Number(s.replace(/\./g, ''));
  }
  if (n <= 0) return { ok: false, reason: `«${v}» debe ser mayor que cero` };
  if (n > CATALOG_LIMITS.maxPriceCop) {
    return {
      ok: false,
      reason: `«${v}» supera el máximo permitido (${CATALOG_LIMITS.maxPriceCop})`,
    };
  }
  return { ok: true, value: n };
}

function cellText(v: CellValue): string | null {
  if (v === null || typeof v === 'object') return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return s ? s : null;
}

/** Valida la tabla leída del archivo contra el esquema del catálogo. */
export function validateCatalog(table: TableData): CatalogValidation {
  const errors: CatalogIssue[] = [];
  const warnings: CatalogIssue[] = [];

  // 1. Encabezados: todas las columnas conocidas (salvo las opcionales) deben existir.
  const index = new Map<string, number>();
  table.headers.forEach((h, i) => {
    const t = cellText(h);
    if (!t) return;
    const norm = normalizeLabel(t);
    if (index.has(norm)) {
      errors.push({ row: table.headerLine, column: t, message: `la columna «${t}» está repetida` });
    } else {
      index.set(norm, i);
    }
  });
  const known = new Set(CATALOG_COLUMNS.map((c) => normalizeLabel(c.header)));
  for (const [norm] of index) {
    if (!known.has(norm)) {
      const original = cellText(table.headers[index.get(norm)!]!) ?? norm;
      warnings.push({
        row: table.headerLine,
        column: original,
        message: `columna «${original}» desconocida: se ignora`,
      });
    }
  }
  const missing = CATALOG_COLUMNS.filter(
    (c) => !c.optionalColumn && !index.has(normalizeLabel(c.header)),
  );
  if (missing.length) {
    errors.push({
      row: table.headerLine,
      message: `faltan columnas: ${missing.map((c) => c.header).join(', ')}`,
    });
    return { ok: false, errors, warnings };
  }

  // 2. Filas.
  const dataRows = table.rows.filter((r) =>
    r.cells.some((c) => cellText(c) !== null || (typeof c === 'object' && c !== null)),
  );
  if (!dataRows.length) {
    errors.push({ message: 'el archivo no tiene planes' });
    return { ok: false, errors, warnings };
  }
  if (dataRows.length > CATALOG_LIMITS.maxRows) {
    errors.push({
      message: `máximo ${CATALOG_LIMITS.maxRows} planes por archivo (tiene ${dataRows.length})`,
    });
    return { ok: false, errors, warnings };
  }

  const records: CatalogRecordData[] = [];
  const codeLine = new Map<string, number>();
  for (const row of dataRows) {
    const rec: Partial<Record<keyof CatalogRecordData, unknown>> = {};
    let rowOk = true;
    for (const col of CATALOG_COLUMNS) {
      const i = index.get(normalizeLabel(col.header));
      const raw: CellValue = i === undefined ? null : (row.cells[i] ?? null);
      const fail = (message: string) => {
        errors.push({ row: row.line, column: col.header, message });
        rowOk = false;
      };
      if (raw !== null && typeof raw === 'object') {
        fail(`la celda tiene un error de Excel (${raw.error})`);
        continue;
      }
      if (col.kind === 'price') {
        const p = parsePriceCop(raw);
        if (p.ok) rec.priceCop = p.value;
        else fail(p.reason === 'vacío' ? 'el precio es obligatorio' : p.reason);
        continue;
      }
      const text = cellText(raw);
      if (!text) {
        if (col.required) fail('es obligatorio');
        else rec[col.key] = null;
        continue;
      }
      switch (col.kind) {
        case 'process': {
          const p = parseProcess(text);
          if (p) rec.process = p;
          else fail(`proceso desconocido «${text}» (usa Portabilidad, Migración o Línea nueva)`);
          break;
        }
        case 'code': {
          if (!CATALOG_LIMITS.codePattern.test(text)) {
            fail(
              `«${text}» no es un ID válido: letra mayúscula seguida de hasta 9 letras mayúsculas o números (p. ej. P1, M20)`,
            );
          } else if (codeLine.has(text)) {
            fail(`el ID ${text} ya está en la fila ${codeLine.get(text)}`);
          } else {
            codeLine.set(text, row.line);
            rec.code = text;
          }
          break;
        }
        case 'text': {
          if (col.maxLength && text.length > col.maxLength) {
            fail(`máximo ${col.maxLength} caracteres (tiene ${text.length})`);
          } else if (/\{\{|\}\}/.test(text)) {
            fail('no puede contener marcadores {{…}}');
          } else {
            rec[col.key] = text;
            const w = instructionLikeWarning(text);
            if (w) warnings.push({ row: row.line, column: col.header, message: w });
          }
          break;
        }
      }
    }
    if (rowOk) records.push(rec as CatalogRecordData);
    if (errors.length >= MAX_REPORTED_ERRORS) {
      errors.push({ message: `hay más errores; se muestran los primeros ${MAX_REPORTED_ERRORS}` });
      break;
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, records, warnings };
}

/** Texto de un problema para mostrar ("Fila 7, Precio: …"). */
export function formatIssue(i: CatalogIssue): string {
  const where = [i.row ? `Fila ${i.row}` : null, i.column ?? null].filter(Boolean).join(', ');
  return where ? `${where}: ${i.message}` : i.message;
}

/** Hash del contenido normalizado de un registro (trazabilidad de lo que vio el cliente). */
export function recordHash(r: CatalogRecordData): string {
  return sha256(canonicalJson(pickData(r)));
}

export function pickData(r: CatalogRecordData): CatalogRecordData {
  return {
    process: r.process,
    code: r.code,
    name: r.name ?? null,
    dataText: r.dataText,
    sharedDataText: r.sharedDataText ?? null,
    includesText: r.includesText ?? null,
    extrasText: r.extrasText ?? null,
    unlimitedAppsText: r.unlimitedAppsText ?? null,
    callsText: r.callsText ?? null,
    priceCop: r.priceCop,
    discountText: r.discountText ?? null,
  };
}

/** Título de la ficha: la columna Nombre o, si no viene, "Plan {ID}". */
export function planTitle(r: Pick<CatalogRecordData, 'name' | 'code'>): string {
  return r.name ?? `Plan ${r.code}`;
}

// ---------- diferencias entre versiones ----------

export interface CatalogFieldChange {
  field: keyof CatalogRecordData;
  label: string;
  before: string | number | null;
  after: string | number | null;
}

export interface CatalogDiff {
  added: { code: string; process: SaleProcess; name: string }[];
  removed: { code: string; process: SaleProcess; name: string }[];
  changed: { code: string; process: SaleProcess; name: string; changes: CatalogFieldChange[] }[];
  unchanged: number;
}

const FIELD_LABEL = Object.fromEntries(CATALOG_COLUMNS.map((c) => [c.key, c.header])) as Record<
  keyof CatalogRecordData,
  string
>;

/** Diferencias por ID: plan agregado, quitado o con campos cambiados (antes → después). */
export function diffCatalogs(before: CatalogRecordData[], after: CatalogRecordData[]): CatalogDiff {
  const prev = new Map(before.map((r) => [r.code, pickData(r)]));
  const next = new Map(after.map((r) => [r.code, pickData(r)]));
  const brief = (r: CatalogRecordData) => ({
    code: r.code,
    process: r.process,
    name: planTitle(r),
  });
  const diff: CatalogDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const [code, r] of next) {
    const old = prev.get(code);
    if (!old) {
      diff.added.push(brief(r));
      continue;
    }
    const changes: CatalogFieldChange[] = [];
    for (const col of CATALOG_COLUMNS) {
      if (old[col.key] !== r[col.key]) {
        changes.push({
          field: col.key,
          label: FIELD_LABEL[col.key],
          before: old[col.key],
          after: r[col.key],
        });
      }
    }
    if (changes.length) diff.changed.push({ ...brief(r), changes });
    else diff.unchanged++;
  }
  for (const [code, r] of prev) if (!next.has(code)) diff.removed.push(brief(r));
  const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
  diff.added.sort(byCode);
  diff.removed.sort(byCode);
  diff.changed.sort(byCode);
  return diff;
}

export function isEmptyDiff(d: CatalogDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length;
}

// ---------- consulta por proceso: consultar_planes(proceso) ----------

/** Un plan de otro proceso llegó al resultado: nunca debe pasar; se corta el turno. */
export class CatalogIntegrityError extends Error {
  override name = 'CatalogIntegrityError';
}

export type PlanQueryResult<T> =
  | { status: 'OK'; process: SaleProcess; plans: T[] }
  /** Resultado vacío explícito: el agente no ofrece nada y aplica su regla de no inventar. */
  | { status: 'SIN_PLANES'; process: SaleProcess; plans: [] };

/**
 * Filtro EXACTO por proceso, ordenado por precio. Verifica el resultado: si un registro de otro
 * proceso se colara (dato corrupto, error de consulta), lanza en vez de devolverlo.
 */
export function queryPlans<T extends { process: string; priceCop: number }>(
  records: readonly T[],
  process: SaleProcess,
): PlanQueryResult<T> {
  const plans = records
    .filter((r) => r.process === process)
    .sort((a, b) => a.priceCop - b.priceCop);
  return checkPlanQuery(plans, process);
}

/** Aserción del resultado de una consulta ya filtrada (p. ej. en SQL). */
export function checkPlanQuery<T extends { process: string }>(
  plans: T[],
  process: SaleProcess,
): PlanQueryResult<T> {
  const intruder = plans.find((p) => p.process !== process);
  if (intruder) {
    throw new CatalogIntegrityError(
      `la consulta de ${process} devolvió un plan de ${intruder.process}`,
    );
  }
  return plans.length
    ? { status: 'OK', process, plans }
    : { status: 'SIN_PLANES', process, plans: [] };
}
