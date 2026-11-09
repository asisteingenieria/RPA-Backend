import { SALE_DATA_LABEL, type SaleDataField } from '@abaya/domain';
import type { Profile } from './types.js';

/**
 * Datos del cliente tras el «SÍ» (13/10/2026). El cliente los manda juntos o en mensajes
 * separados; el código los reconoce (sin el modelo) y la venta pasa al backoffice cuando están
 * los que pide el flujo. Viven solo en el perfil cifrado de la conversación (regla 6).
 */
export interface SaleData {
  document?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  /** D-033 (blueprint, PLT-013): ciudad del cliente. */
  city?: string;
}

const EMAIL = /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/u;
/** Números con o sin separadores: 1.020.304.050, 300 123 4567, 1020304050. */
const NUMBER = /\d(?:[\d.\s-]*\d)?/g;
const PHONE_HINT = /cel(?:ular)?|tel[eé]fono|m[oó]vil|whats?app|contacto|l[ií]nea/i;
const DOC_HINT =
  /c[eé]dula|\bc\.?\s?c\.?\b|documento|\bdni\b|identificaci[oó]n|\bpasaporte\b|\bc\.?\s?e\.?\b/i;
/** Etiquetas que acompañan los datos y no son parte del nombre. */
const LABELS =
  /\b(?:mi\s+nombre(?:\s+completo)?\s+es|nombre(?:\s+completo)?|me\s+llamo|soy|c[eé]dula|documento(?:\s+de\s+identidad)?|identificaci[oó]n|correo(?:\s+electr[oó]nico)?|e-?mail|mail|celular|tel[eé]fono|l[ií]nea(?:\s+a)?\s+activar|l[ií]nea|n[uú]mero(?:\s+de)?|cc|ce)\b[:.]?/giu;

/** D-033: «Ciudad: Bogotá» (como en la plantilla de captura), hasta el fin de línea o la coma. */
const CITY_LABELED = /\bciudad\s*[:-]?\s*([\p{L}][\p{L} .'-]{2,39})/iu;
/** Ciudades principales: se reconocen sin etiqueta («…, 3001234567, Medellín»). */
const CITIES = [
  'bogota',
  'medellin',
  'cali',
  'barranquilla',
  'cartagena',
  'cucuta',
  'bucaramanga',
  'pereira',
  'santa marta',
  'ibague',
  'manizales',
  'villavicencio',
  'pasto',
  'monteria',
  'neiva',
  'armenia',
  'valledupar',
  'sincelejo',
  'popayan',
  'tunja',
  'riohacha',
  'florencia',
  'quibdo',
  'yopal',
  'soacha',
  'bello',
  'itagui',
  'envigado',
  'soledad',
  'palmira',
  'buenaventura',
  'tulua',
  'girardot',
  'zipaquira',
  'facatativa',
  'chia',
  'fusagasuga',
  'duitama',
  'sogamoso',
  'apartado',
  'barrancabermeja',
  'floridablanca',
  'giron',
  'piedecuesta',
  'dosquebradas',
  'cartago',
  'buga',
  'jamundi',
  'rionegro',
  'mosquera',
  'funza',
  'leticia',
  'san andres',
  'arauca',
  'mocoa',
];
/** Sin tildes ni mayúsculas, un carácter por cada carácter del original (lo demás, espacio). */
const fold = (s: string) =>
  [...s]
    .map((ch) => {
      const f = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      return f.length === 1 && /[a-zñ]/.test(f) ? f : ' ';
    })
    .join('');

/** La ciudad del mensaje y el texto que la contiene (para no tomarla como parte del nombre). */
function findCity(text: string): { city: string; raw: string } | undefined {
  const labeled = CITY_LABELED.exec(text);
  if (labeled) {
    const raw = labeled[0].split(/[\n,;]/)[0]!;
    const city = labeled[1]!
      .split(/[\n,;]/)[0]!
      .trim()
      .replace(/\.+$/, '');
    if (city.length >= 3) return { city, raw };
  }
  // Sin etiqueta, solo si va sola en su renglón o entre comas («Pereira» dentro de «Juan Pereira»
  // es un apellido), con «en», «de» o «vivo en» delante como mucho.
  for (const part of text.split(/[\n,;]/)) {
    const seg = part.trim();
    const bare = fold(seg)
      .replace(/^\s*(?:vivo\s+en|estoy\s+en|desde|de|en)\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!CITIES.includes(bare)) continue;
    const words = seg.split(/\s+/).slice(-bare.split(' ').length);
    const city = words.map((w) => w.charAt(0).toLocaleUpperCase('es-CO') + w.slice(1)).join(' ');
    return { city: city.replace(/[.!]+$/, ''), raw: seg };
  }
  return undefined;
}
/** Palabras que delatan una frase y no un nombre («no tengo correo», «ya te lo envié»). */
const NOT_A_NAME = new Set(
  (
    'no si sí ok okay listo claro gracias porque por para que qué como cómo cuando cuándo donde ' +
    'dónde tengo tiene quiero puedo puede envié envie mande mandé ahí ahi ya te le lo los mis tu su ' +
    'un una es son está esta estoy hola buenas buenos días dias tardes noches señor señora sr sra ' +
    'favor espera momento después despues luego cual cuál todo todos bien'
  ).split(/\s+/),
);
/** Conectores que sí pueden ir dentro de un nombre («María de los Ángeles»). */
const NAME_JOINERS = new Set(['de', 'del', 'la', 'las', 'los', 'y']);

const capitalize = (w: string) =>
  NAME_JOINERS.has(w) ? w : w.charAt(0).toLocaleUpperCase('es-CO') + w.slice(1);

/** Lo que trae un mensaje: documento, nombre completo (2+ palabras), correo y celular. */
export function extractSaleData(text: string): SaleData {
  const out: SaleData = {};
  let rest = ` ${text} `;
  const city = findCity(text);
  if (city) {
    out.city = city.city;
    rest = rest.replace(city.raw, ' ');
  }
  const email = EMAIL.exec(rest)?.[0];
  if (email) {
    out.email = email.toLowerCase();
    rest = rest.replace(email, ' ');
  }
  // Cada número mira solo el texto que lo antecede desde el número anterior («cel 300… y cédula 52…»).
  let lastEnd = 0;
  for (const m of rest.matchAll(NUMBER)) {
    const digits = m[0].replace(/\D/g, '');
    const before = rest.slice(lastEnd, m.index!);
    lastEnd = m.index! + m[0].length;
    // Cédulas antiguas pueden ser cortas: desde 4 dígitos.
    if (digits.length < 4 || digits.length > 12) continue;
    const isPhone =
      PHONE_HINT.test(before) ||
      (!DOC_HINT.test(before) && digits.length === 10 && digits.startsWith('3'));
    if (isPhone && !out.phone) out.phone = digits;
    else if (!isPhone && !out.document) out.document = digits;
  }
  rest = rest.replace(NUMBER, ' ').replace(LABELS, ' ');
  const words = (rest.match(/[\p{L}'´-]+/gu) ?? []).map((w) => w.toLowerCase());
  const meaningful = words.filter((w) => !NAME_JOINERS.has(w));
  if (
    meaningful.length >= 2 &&
    meaningful.length <= 6 &&
    meaningful.every((w) => w.length >= 2 && !NOT_A_NAME.has(w))
  ) {
    out.fullName = words.map(capitalize).join(' ');
  }
  return out;
}

/** Qué dato del flujo ya está en el perfil (el nombre dicho antes cuenta si es completo). */
export function hasSaleData(p: Profile, f: SaleDataField): boolean {
  switch (f) {
    case 'DOCUMENTO':
      return !!p.saleDocument;
    case 'NOMBRE':
      return !!p.saleFullName || (p.name?.trim().split(/\s+/).length ?? 0) >= 2;
    case 'CORREO':
      return !!p.saleEmail;
    case 'CELULAR':
      return !!p.salePhone;
    case 'CIUDAD':
      return !!p.saleCity;
  }
}

/** Perfil con lo nuevo del mensaje (lo último que dijo el cliente manda) y si trajo algo. */
export function mergeSaleData(p: Profile, d: SaleData): { profile: Profile; gotNew: boolean } {
  const next: Profile = { ...p };
  let gotNew = false;
  const set = (
    k: 'saleDocument' | 'saleFullName' | 'saleEmail' | 'salePhone' | 'saleCity',
    v?: string,
  ) => {
    if (!v || next[k] === v) return;
    next[k] = v;
    gotNew = true;
  };
  set('saleDocument', d.document);
  set('saleFullName', d.fullName);
  set('saleEmail', d.email);
  set('salePhone', d.phone);
  set('saleCity', d.city);
  return { profile: next, gotNew };
}

/** «tu nombre completo y tu correo electrónico». */
export function missingDataText(fields: readonly SaleDataField[]): string {
  const parts = fields.map((f) => SALE_DATA_LABEL[f]);
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
}

/** Líneas para el resumen de la venta (backoffice), con lo que faltó si se transfirió sin todo. */
export function saleDataSummary(p: Profile, required: readonly SaleDataField[]): string {
  const missing = required.filter((f) => !hasSaleData(p, f));
  return [
    'Datos del cliente:',
    `Documento: ${p.saleDocument ?? 'N/D'}`,
    `Nombre completo: ${p.saleFullName ?? p.name ?? 'N/D'}`,
    `Correo: ${p.saleEmail ?? 'N/D'}`,
    `Celular: ${p.salePhone ?? 'el del chat de Avaya'}`,
    ...(required.includes('CIUDAD') || p.saleCity ? [`Ciudad: ${p.saleCity ?? 'N/D'}`] : []),
    ...(missing.length ? [`Faltó: ${missingDataText(missing)} (el backoffice lo pide)`] : []),
  ].join('\n');
}
