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
}

const EMAIL = /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/u;
/** Números con o sin separadores: 1.020.304.050, 300 123 4567, 1020304050. */
const NUMBER = /\d(?:[\d.\s-]*\d)?/g;
const PHONE_HINT = /cel(?:ular)?|tel[eé]fono|m[oó]vil|whats?app|contacto/i;
const DOC_HINT =
  /c[eé]dula|\bc\.?\s?c\.?\b|documento|\bdni\b|identificaci[oó]n|\bpasaporte\b|\bc\.?\s?e\.?\b/i;
/** Etiquetas que acompañan los datos y no son parte del nombre. */
const LABELS =
  /\b(?:mi\s+nombre(?:\s+completo)?\s+es|nombre(?:\s+completo)?|me\s+llamo|soy|c[eé]dula|documento(?:\s+de\s+identidad)?|identificaci[oó]n|correo(?:\s+electr[oó]nico)?|e-?mail|mail|celular|tel[eé]fono|n[uú]mero|cc|ce)\b[:.]?/giu;
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
  }
}

/** Perfil con lo nuevo del mensaje (lo último que dijo el cliente manda) y si trajo algo. */
export function mergeSaleData(p: Profile, d: SaleData): { profile: Profile; gotNew: boolean } {
  const next: Profile = { ...p };
  let gotNew = false;
  const set = (k: 'saleDocument' | 'saleFullName' | 'saleEmail' | 'salePhone', v?: string) => {
    if (!v || next[k] === v) return;
    next[k] = v;
    gotNew = true;
  };
  set('saleDocument', d.document);
  set('saleFullName', d.fullName);
  set('saleEmail', d.email);
  set('salePhone', d.phone);
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
    `Celular: ${p.salePhone ?? 'el del chat de Abaya'}`,
    ...(missing.length ? [`Faltó: ${missingDataText(missing)} (el backoffice lo pide)`] : []),
  ].join('\n');
}
