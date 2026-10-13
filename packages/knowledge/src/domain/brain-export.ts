import type { PlanImageCard } from './images.js';

/**
 * D-019: un Brain como archivo para llevarlo a otro ambiente (local → producción). Lleva sus
 * fuentes con su contenido; al importarse se crea un Brain nuevo en borrador. Las imágenes viajan
 * con lo leído de cada tarjeta (lo que se revisó en el panel), así no se vuelven a leer.
 */
export const BRAIN_EXPORT_FORMAT = 'abaya-brain';
export const BRAIN_EXPORT_VERSION = 1;

export interface BrainExportSource {
  kind: 'FILE' | 'TEXT' | 'WEB';
  use: string;
  name: string;
  mime: string | null;
  /** Metadato de la fuente (proceso, procesos de la imagen, descuentos…). */
  metadata: Record<string, string> | null;
  /** Archivos e imágenes: el contenido en base64. */
  data?: string;
  /** Textos escritos en el panel. */
  text?: string;
  /** Páginas web: se vuelven a descargar al importar. */
  url?: string;
  refreshHours?: number | null;
  /** Imágenes: lo leído de cada tarjeta. */
  cards?: PlanImageCard[];
}

export interface BrainExport {
  formato: typeof BRAIN_EXPORT_FORMAT;
  version: typeof BRAIN_EXPORT_VERSION;
  exportadoEn: string;
  nombre: string;
  fuentes: BrainExportSource[];
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
const optStr = (v: unknown, max: number) =>
  v === undefined || v === null ? null : str(v, max) === null ? undefined : (v as string);

/** Lo leído de una tarjeta, revisado campo por campo (viene de un archivo externo). */
export function parsePlanImageCards(raw: unknown): PlanImageCard[] | null {
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const out: PlanImageCard[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') return null;
    const r = c as Record<string, unknown>;
    const code = optStr(r.code, 40);
    const dataText = str(r.dataText, 80);
    const price = r.priceCop;
    if (code === undefined || !dataText || typeof price !== 'number' || !Number.isInteger(price))
      return null;
    if (price <= 0 || price > 10_000_000) return null;
    const card: PlanImageCard = { code, dataText, priceCop: price };
    for (const k of ['sharedDataText', 'includesText', 'unlimitedAppsText', 'callsText'] as const) {
      const v = optStr(r[k], 300);
      if (v === undefined) return null;
      if (v !== null) card[k] = v;
    }
    out.push(card);
  }
  return out;
}

/**
 * Lee un archivo exportado: el sobre y la forma de cada fuente. El contenido (tipo real del
 * archivo, catálogo, dirección web) lo vuelve a revisar quien importa, como al cargarlo a mano.
 */
export function readBrainExport(
  raw: unknown,
): { ok: true; value: BrainExport } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: 'el archivo no es un JSON válido' };
  const r = raw as Record<string, unknown>;
  if (r.formato !== BRAIN_EXPORT_FORMAT)
    return {
      ok: false,
      error: 'el archivo no es una exportación de un Brain (formato «abaya-brain»)',
    };
  if (r.version !== BRAIN_EXPORT_VERSION)
    return { ok: false, error: `versión de archivo no soportada: ${String(r.version)}` };
  const nombre = str(r.nombre, 120)?.trim();
  if (!nombre) return { ok: false, error: 'el archivo no trae el nombre del Brain' };
  if (!Array.isArray(r.fuentes) || r.fuentes.length > 200)
    return { ok: false, error: 'el archivo no trae la lista de fuentes' };
  const fuentes: BrainExportSource[] = [];
  for (const [i, f] of (r.fuentes as unknown[]).entries()) {
    const bad = (why: string) => ({ ok: false as const, error: `fuente ${i + 1}: ${why}` });
    if (!f || typeof f !== 'object') return bad('forma inválida');
    const s = f as Record<string, unknown>;
    const kind = s.kind;
    if (kind !== 'FILE' && kind !== 'TEXT' && kind !== 'WEB') return bad('tipo desconocido');
    const use = str(s.use, 30);
    const name = str(s.name, 300);
    if (!use || !name) return bad('sin uso o sin nombre');
    const metadata =
      s.metadata && typeof s.metadata === 'object'
        ? Object.fromEntries(
            Object.entries(s.metadata as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string' && e[1].length <= 2_000,
            ),
          )
        : null;
    const src: BrainExportSource = { kind, use, name, mime: str(s.mime, 120), metadata };
    if (kind === 'FILE') {
      const data = str(s.data, 40 * 1024 * 1024);
      if (!data) return bad('archivo sin contenido');
      src.data = data;
      if (use === 'IMAGE') {
        const cards = parsePlanImageCards(s.cards);
        if (!cards) return bad('imagen sin lo leído de sus tarjetas');
        src.cards = cards;
      }
    } else if (kind === 'TEXT') {
      const text = str(s.text, 200_000);
      if (!text) return bad('texto vacío');
      src.text = text;
    } else {
      const url = str(s.url, 2_000);
      if (!url) return bad('página sin dirección');
      src.url = url;
      src.refreshHours = typeof s.refreshHours === 'number' ? s.refreshHours : null;
    }
    fuentes.push(src);
  }
  return {
    ok: true,
    value: {
      formato: BRAIN_EXPORT_FORMAT,
      version: BRAIN_EXPORT_VERSION,
      exportadoEn: typeof r.exportadoEn === 'string' ? r.exportadoEn : '',
      nombre,
      fuentes,
    },
  };
}
