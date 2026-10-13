import {
  PROCESS_LABEL,
  SALE_PROCESSES,
  type CatalogRecordData,
  type SaleProcess,
} from './catalog.js';

/**
 * Imágenes de planes (docs/DECISIONS.md D-011). Los asesores humanos envían los planes como
 * imágenes; el agente hace lo mismo al elegir el proceso. La imagen es APOYO VISUAL del
 * catálogo, no otra fuente de precios: cada plan que muestra (GB y precio) debe existir igual en
 * el catálogo de la misma versión del Brain, o la versión no se publica (D-007).
 */

export const IMAGE_MIMES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;
export type ImageExt = keyof typeof IMAGE_MIMES;

export const IMAGE_LIMITS = {
  /** WhatsApp acepta hasta 5 MB; las tarjetas de planes pesan ~150 KB. */
  maxBytes: 3 * 1024 * 1024,
  /** Más de esto por proceso satura el chat del cliente. */
  perProcess: 5,
} as const;

/** Un plan leído de la imagen. */
export interface PlanImageCard {
  /** Código impreso en la tarjeta (p. ej. 38327), si lo tiene. */
  code: string | null;
  /** Datos tal como aparecen: «65 GB», «GB ilimitadas». */
  dataText: string;
  priceCop: number;
  /**
   * D-014: el resto de la tarjeta, tal como aparece (las versiones anteriores no lo leían). Con
   * catálogo desde imágenes, estos textos son lo que el agente puede decir del plan.
   */
  sharedDataText?: string | null;
  /** «Claro video + Prime video + Claro club + Claro drive + Claro música». */
  includesText?: string | null;
  /** «X, WhatsApp y Facebook al agotar los datos del plan». */
  unlimitedAppsText?: string | null;
  /** «Minutos y SMS ilimitados nacional + LDI USA, Canadá, México y Puerto Rico». */
  callsText?: string | null;
}

/** Lo que guarda una fuente de uso IMAGE al procesarse (`KnowledgeSource.parsed`). */
export interface PlanImageSourceData {
  processes: SaleProcess[];
  cards: PlanImageCard[];
  /** Modelo que leyó la imagen (trazabilidad). */
  model: string;
  /**
   * D-014: circular de apps de video (WIN, Disney+, Netflix). Aplica a todos los procesos y se
   * envía solo si el cliente habla de plataformas de video.
   */
  videoApps?: boolean;
}

/** Imagen congelada en una versión. */
export interface VersionImageData {
  sourceName: string;
  sourceHash: string;
  blobRef: string;
  mime: string;
  sizeBytes: number;
  processes: SaleProcess[];
  ord: number;
  cards: PlanImageCard[];
  /** D-014 */
  videoApps?: boolean;
  /**
   * D-016: descuento de los planes de la imagen en cada proceso (comentario escrito en el panel,
   * p. ej. «✅Descuento del 25% en la 1 y 2 facturación»). Va al campo Descuento de cada plan.
   */
  discounts?: ImageDiscounts;
}

/** D-016: descuento por proceso de una imagen (las imágenes no lo traen impreso). */
export type ImageDiscounts = Partial<Record<SaleProcess, string>>;

export const IMAGE_DISCOUNT_MAX = 300;

/** Clave del metadato de la fuente con el descuento de un proceso (`descuento_PORTABILIDAD`). */
export const imageDiscountKey = (p: SaleProcess) => `descuento_${p}`;

/**
 * D-016: descuentos de una imagen desde el metadato de su fuente (o del formulario del panel),
 * solo de los procesos que se piden, sin vacíos y con las líneas normalizadas.
 */
export function parseImageDiscounts(
  raw: unknown,
  processes: readonly SaleProcess[] = SALE_PROCESSES,
): ImageDiscounts {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ImageDiscounts = {};
  for (const p of processes) {
    const v = r[imageDiscountKey(p)];
    const text = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
    if (text) out[p] = text;
  }
  return out;
}

// ---------- D-014: catálogo desde las imágenes (sin Excel) ----------

const PROCESS_PREFIX: Record<SaleProcess, string> = {
  PORTABILIDAD: 'P',
  MIGRACION: 'M',
  LINEA_NUEVA: 'L',
};

/**
 * Código interno del plan en un proceso: inicial del proceso + código impreso (P38327). El mismo
 * plan puede estar en varios procesos y el código debe ser único por versión. Sin código impreso,
 * el precio (P52900). Nunca se muestra al cliente.
 */
export function imageRecordCode(process: SaleProcess, card: PlanImageCard): string {
  const raw = (card.code ?? String(card.priceCop)).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return `${PROCESS_PREFIX[process]}${raw}`.slice(0, 10);
}

/**
 * Registros del catálogo a partir de lo leído en las imágenes (cuando el Brain no tiene Excel).
 * Las de apps de video aplican a todos los procesos. Un mismo plan repetido en dos imágenes del
 * mismo proceso se toma una vez; si los datos difieren, la validación lo reporta.
 */
export function recordsFromImages(
  images: readonly Pick<VersionImageData, 'processes' | 'cards' | 'videoApps' | 'discounts'>[],
): CatalogRecordData[] {
  const out = new Map<string, CatalogRecordData>();
  for (const img of images) {
    const processes = img.videoApps ? [...SALE_PROCESSES] : img.processes;
    for (const process of processes) {
      for (const card of img.cards) {
        const code = imageRecordCode(process, card);
        if (out.has(code)) continue;
        out.set(code, {
          process,
          code,
          // Título para el cliente (ficha y catálogo): nunca el código interno (P38327).
          name: `Plan ${card.dataText}`,
          dataText: card.dataText,
          sharedDataText: card.sharedDataText ?? null,
          includesText: card.includesText ?? null,
          extrasText: null,
          unlimitedAppsText: card.unlimitedAppsText ?? null,
          callsText: card.callsText ?? null,
          priceCop: card.priceCop,
          // Las imágenes no traen descuentos (D-014); D-016: el que se escribió en el panel para
          // esta imagen y este proceso. Sin él, el agente no menciona descuentos de este plan.
          discountText: img.discounts?.[process]?.trim() || null,
        });
      }
    }
  }
  return [...out.values()];
}

/** «PORTABILIDAD,MIGRACION» (metadato de la fuente) → lista validada, sin repetidos. */
export function parseImageProcesses(raw: unknown): SaleProcess[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out = new Set<SaleProcess>();
  for (const p of list) {
    const v = typeof p === 'string' ? p.trim().toUpperCase() : '';
    if ((SALE_PROCESSES as readonly string[]).includes(v)) out.add(v as SaleProcess);
  }
  return SALE_PROCESSES.filter((p) => out.has(p));
}

/**
 * D-014: marca «apps de video» de una imagen (campo `appsVideo` del formulario o del metadato):
 * `true`, «true», «1», «si», «sí».
 */
export function parseVideoAppsFlag(raw: unknown): boolean {
  if (raw === true) return true;
  return typeof raw === 'string' && /^(true|1|s[ií])$/i.test(raw.trim());
}

/** «65 GB» / «65GB» / «GB ILIMITADAS» → clave comparable («65gb», «ilimitadas»). */
export function dataKey(text: string): string {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/ilimitad/.test(t)) return 'ilimitadas';
  const m = /(\d+(?:[.,]\d+)?)\s*(gb|mb)/.exec(t);
  return m ? `${m[1]!.replace(',', '.')}${m[2]}` : t.replace(/\s+/g, '');
}

export function formatCopPlain(value: number): string {
  return '$' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(value);
}

export const describeCard = (c: PlanImageCard) =>
  `${c.code ? `${c.code} · ` : ''}${c.dataText} · ${formatCopPlain(c.priceCop)}`;

export interface CardMatch {
  card: PlanImageCard;
  /** Código del registro del catálogo que coincide (null = no coincide). */
  code: string | null;
  problem: string | null;
}

/**
 * Busca cada plan de la imagen en el catálogo del proceso. Si el código impreso existe en el
 * catálogo, GB y precio deben ser iguales; si no, se busca por GB + precio.
 */
export function matchImageCards(
  cards: readonly PlanImageCard[],
  records: readonly CatalogRecordData[],
  process: SaleProcess,
): CardMatch[] {
  const plans = records.filter((r) => r.process === process);
  const label = PROCESS_LABEL[process];
  return cards.map((card) => {
    // D-014: con catálogo desde imágenes el código interno lleva la inicial del proceso (P38327).
    const own = imageRecordCode(process, card);
    const byCode = card.code
      ? plans.find((r) => r.code === card.code || r.code === own)
      : undefined;
    if (byCode) {
      const diffs: string[] = [];
      if (byCode.priceCop !== card.priceCop)
        diffs.push(
          `precio ${formatCopPlain(card.priceCop)} y el catálogo dice ${formatCopPlain(byCode.priceCop)}`,
        );
      if (dataKey(byCode.dataText) !== dataKey(card.dataText))
        diffs.push(`datos «${card.dataText}» y el catálogo dice «${byCode.dataText}»`);
      return diffs.length
        ? {
            card,
            code: null,
            problem: `el plan ${card.code} de ${label} tiene ${diffs.join(' y ')}`,
          }
        : { card, code: byCode.code, problem: null };
    }
    const same = plans.find(
      (r) => r.priceCop === card.priceCop && dataKey(r.dataText) === dataKey(card.dataText),
    );
    return same
      ? { card, code: same.code, problem: null }
      : {
          card,
          code: null,
          problem: `el plan ${describeCard(card)} no está en el catálogo de ${label}`,
        };
  });
}

export interface ImageCheck {
  sourceName: string;
  /** Por proceso: códigos del catálogo que muestra la imagen. */
  codes: Partial<Record<SaleProcess, string[]>>;
  problems: string[];
}

/**
 * Validación de las imágenes contra el catálogo de la MISMA versión. Sin problemas, cada imagen
 * solo muestra planes que el agente conoce con esos mismos GB y precio.
 */
export function checkPlanImages(
  images: readonly Pick<VersionImageData, 'sourceName' | 'processes' | 'cards' | 'videoApps'>[],
  records: readonly CatalogRecordData[],
): { images: ImageCheck[]; problems: string[] } {
  const checks: ImageCheck[] = [];
  const perProcess = new Map<SaleProcess, number>();
  for (const img of images) {
    const check: ImageCheck = { sourceName: img.sourceName, codes: {}, problems: [] };
    // D-014: la circular de apps de video aplica a todos los procesos y no cuenta para el tope.
    const processes = img.videoApps ? [...SALE_PROCESSES] : img.processes;
    if (!processes.length) check.problems.push('no tiene proceso asignado');
    if (!img.cards.length) check.problems.push('no se leyó ningún plan en la imagen');
    for (const c of img.cards) {
      if (!Number.isInteger(c.priceCop) || c.priceCop <= 0)
        check.problems.push(`no se leyó el precio del plan ${describeCard(c)}`);
    }
    if (!records.length) check.problems.push('el Brain no tiene catálogo de planes');
    else {
      for (const process of processes) {
        if (!img.videoApps) perProcess.set(process, (perProcess.get(process) ?? 0) + 1);
        const matches = matchImageCards(img.cards, records, process);
        check.codes[process] = matches.flatMap((m) => (m.code ? [m.code] : []));
        check.problems.push(...matches.flatMap((m) => (m.problem ? [m.problem] : [])));
      }
    }
    checks.push(check);
  }
  const problems = checks.flatMap((c) => c.problems.map((p) => `Imagen «${c.sourceName}»: ${p}`));
  for (const [process, n] of perProcess) {
    if (n > IMAGE_LIMITS.perProcess) {
      problems.push(
        `${PROCESS_LABEL[process]} tiene ${n} imágenes: el máximo es ${IMAGE_LIMITS.perProcess}`,
      );
    }
  }
  return { images: checks, problems };
}

// ---------- diferencias entre versiones ----------

export interface ImageDiff {
  added: { source: string; processes: SaleProcess[] }[];
  removed: { source: string; processes: SaleProcess[] }[];
  /** Misma imagen (por nombre) con otro archivo u otros procesos. */
  changed: { source: string; processes: SaleProcess[] }[];
}

export function diffImages(
  before: readonly Pick<VersionImageData, 'sourceName' | 'sourceHash' | 'processes'>[],
  after: readonly Pick<VersionImageData, 'sourceName' | 'sourceHash' | 'processes'>[],
): ImageDiff {
  const key = (i: { sourceHash: string; processes: readonly string[] }) =>
    `${i.sourceHash}|${[...i.processes].sort().join(',')}`;
  const prev = new Map(before.map((i) => [i.sourceName, i]));
  const next = new Map(after.map((i) => [i.sourceName, i]));
  const diff: ImageDiff = { added: [], removed: [], changed: [] };
  for (const [name, n] of next) {
    const p = prev.get(name);
    if (!p) diff.added.push({ source: name, processes: [...n.processes] });
    else if (key(p) !== key(n)) diff.changed.push({ source: name, processes: [...n.processes] });
  }
  for (const [name, p] of prev) {
    if (!next.has(name)) diff.removed.push({ source: name, processes: [...p.processes] });
  }
  return diff;
}

export function isEmptyImageDiff(d: ImageDiff | undefined): boolean {
  return !d || (!d.added.length && !d.removed.length && !d.changed.length);
}

/** Lo que el agente envía: imágenes de un proceso, en orden, con los planes que muestran. */
export interface PlanImageRef {
  imageId: string;
  brainId: string;
  versionId: string;
  version: number;
  sourceName: string;
  mime: string;
  /** Códigos del catálogo que muestra (trazabilidad: qué precios vio el cliente). */
  codes: string[];
  /** La imagen se cargó para varios procesos (informativo: el orden de envío es por precio). */
  shared?: boolean;
}
