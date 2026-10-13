import { FEATURE_FIELDS, planTitle } from '@abaya/knowledge';
import { FORBIDDEN_PROMISES as DOMAIN_FORBIDDEN_PROMISES } from '@abaya/domain';
import type { Plan } from '../../catalog/catalog.js';

/**
 * D-007: el modelo puede escribir precios, gigas, porcentajes y beneficios (guion estilo Dapta),
 * pero cada cifra se VERIFICA contra lo publicado: el catálogo del proceso del cliente y los
 * textos que un ADMIN revisó y publicó (guion e información de la empresa). Lo que no coincide
 * se rechaza (regla 10), así que el modelo copia, no inventa.
 */

/** De dónde puede salir una cifra o una palabra delicada en la respuesta. */
export interface FigureSources {
  /** Planes activos del proceso de la conversación (nunca los de otros procesos). */
  plans: readonly Plan[];
  /** Textos aprobados del agente publicado: guion e información de la empresa. */
  approvedTexts: readonly string[];
}

type Kind = 'money' | 'data' | 'percent' | 'plain';

interface Figure {
  raw: string;
  kind: Kind;
  /** Valor normalizado: dígitos sin separadores de miles; decimales con punto. */
  key: string;
}

const NUMBER_RE =
  /(\$\s*)?(\d{1,3}(?:[.,]\d{3})+(?![.,]?\d)|\d+(?:[.,]\d+)?)(\s*(?:%|gb\b|gigas?\b|megas?\b|mb\b|mil\b|cop\b|pesos\b))?/gi;

/** Cifras de un texto con su tipo (precio, datos, porcentaje o número suelto). */
export function figuresIn(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const dollar = m[1];
    const num = m[2]!;
    const unitRaw = m[3];
    const unit = unitRaw?.trim().toLowerCase();
    const thousands = /^\d{1,3}(?:[.,]\d{3})+$/.test(num);
    let key = thousands ? num.replace(/[.,]/g, '') : num.replace(',', '.');
    let kind: Kind = 'plain';
    if (dollar || unit === 'cop' || unit === 'pesos' || unit === 'mil') {
      kind = 'money';
      if (unit === 'mil') key = String(Math.round(Number(key) * 1000));
    } else if (unit === '%') kind = 'percent';
    else if (unit) kind = 'data';
    out.push({ raw: raw.trim(), kind, key: kind === 'money' ? String(Number(key)) : key });
  }
  return out;
}

/** Descuentos que no son sobre el cargo fijo del plan (equipo, otra línea, roaming…). */
const NOT_PLAN_DISCOUNT =
  /equipo|celular|tel[eé]fono|terminal|l[ií]nea\s+adicional|segunda\s+l[ií]nea|roaming|instalaci[oó]n/i;

/**
 * Precio del plan con su descuento, calculado por el CÓDIGO (no por el modelo): solo si el campo
 * Descuento trae un único porcentaje y no habla de otra cosa que el plan. Ej.: $99.900 con
 * «20% CFM en mes 1, 2, 3, 4 y 5» → $79.920. null si no se puede calcular sin adivinar.
 */
export function discountedPriceCop(p: Plan): number | null {
  if (!p.discountText || NOT_PLAN_DISCOUNT.test(p.discountText)) return null;
  const pct = figuresIn(p.discountText).filter((f) => f.kind === 'percent');
  if (pct.length !== 1) return null;
  const v = Number(pct[0]!.key);
  if (!(v > 0 && v < 100)) return null;
  return Math.round(p.priceCop * (1 - v / 100));
}

/** Textos de un plan tal como están publicados (etiquetas incluidas si el campo existe). */
function planTexts(p: Plan): string[] {
  const texts = [planTitle(p)];
  for (const [key, label] of FEATURE_FIELDS) {
    const v = p[key];
    if (v) texts.push(`${label}: ${v}`);
  }
  if (p.discountText) texts.push(p.discountText);
  return texts;
}

interface Allowed {
  money: Set<string>;
  data: Set<string>;
  percent: Set<string>;
  plain: Set<string>;
}

function allowedFigures(src: FigureSources): Allowed {
  const a: Allowed = { money: new Set(), data: new Set(), percent: new Set(), plain: new Set() };
  for (const p of src.plans) {
    // Precios: solo el valor oficial del plan y los que traiga su campo de descuento. Un texto
    // libre del catálogo (p. ej. «Incluye») no puede aprobar un precio.
    a.money.add(String(p.priceCop));
    a.plain.add(String(p.priceCop));
    // El precio con descuento lo calcula el código (discountedPriceCop): también es del catálogo.
    const discounted = discountedPriceCop(p);
    if (discounted !== null) {
      a.money.add(String(discounted));
      a.plain.add(String(discounted));
    }
    for (const text of planTexts(p)) {
      const isDiscount = text === p.discountText;
      for (const f of figuresIn(text)) {
        if (f.kind !== 'money' || isDiscount) a[f.kind].add(f.key);
        if (f.kind !== 'money') a.plain.add(f.key);
      }
    }
  }
  // Del guion solo valen números sueltos (líneas de atención, leyes, «5G»): la revisión al
  // guardar ya impide precios, gigas y porcentajes en el guion (regla 11 del panel).
  for (const t of src.approvedTexts) for (const f of figuresIn(t)) a.plain.add(f.key);
  return a;
}

const KIND_LABEL: Record<Kind, string> = {
  money: 'precio',
  data: 'datos',
  percent: 'porcentaje',
  plain: 'número',
};

/** Cifras escritas en letras junto a una unidad («treinta mil pesos», «cincuenta megas»). */
const SPELLED_RE =
  /\b(?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|veinti\p{L}+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|\p{L}+cientos|quinientos|mil|mill[oó]n|millones)\b(?:\s+(?:y\s+)?\p{L}+){0,3}?\s+(?:gb|gigas?|megas?|mb|pesos|cop|mil|por\s*ciento)\b/giu;

/** Errores por cada cifra de `text` que no sale del catálogo del proceso ni del guion. */
export function unverifiedFigures(text: string, src: FigureSources): string[] {
  const allowed = allowedFigures(src);
  const errors: string[] = [];
  for (const m of text.matchAll(SPELLED_RE)) {
    errors.push(
      `cifras: "${m[0]}" escrito en letras; copia la cifra tal como está en <datos_catalogo>`,
    );
  }
  for (const f of figuresIn(text)) {
    const ok = f.kind === 'plain' ? allowed.plain.has(f.key) : allowed[f.kind].has(f.key);
    if (!ok) {
      errors.push(
        `cifras: ${KIND_LABEL[f.kind]} "${f.raw}" no está en el catálogo de este cliente; copia las cifras literalmente de <datos_catalogo>`,
      );
    }
  }
  return errors;
}

const normalize = (s: string) => s.toLowerCase().normalize('NFC');

/**
 * Frases delicadas («ilimitado», «descuento», «gratis»…) que la respuesta usa sin que aparezcan
 * en el catálogo publicado del proceso (p. ej. «Minutos ilimitados») ni en el guion publicado.
 */
export function unapprovedPhrases(text: string, src: FigureSources): string[] {
  const lower = normalize(text);
  // Un plan con la columna Descuento llena aprueba la palabra aunque su texto no la diga.
  const discountLabels = src.plans.filter((p) => p.discountText).map(() => 'descuento');
  const approved = normalize(
    [...src.plans.flatMap(planTexts), ...discountLabels, ...src.approvedTexts].join('\n'),
  );
  return DOMAIN_FORBIDDEN_PROMISES.filter((p) => lower.includes(p) && !approved.includes(p));
}

/** Planes del catálogo cuyo precio aparece escrito en el texto (el modelo los describió). */
export function plansDescribed(text: string, plans: readonly Plan[]): Plan[] {
  const keys = new Set(
    figuresIn(text)
      .filter((f) => f.kind === 'money' || f.kind === 'plain')
      .map((f) => String(Number(f.key))),
  );
  return plans.filter((p) => keys.has(String(p.priceCop)));
}

/** Markdown → formato WhatsApp: **negrita** y __cursiva__ con un solo símbolo. */
export function toWhatsApp(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/gs, '*$1*').replace(/__(.+?)__/gs, '_$1_');
}
