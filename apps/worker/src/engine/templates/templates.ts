import { DEFAULT_AGENT_CONFIG, menuText } from '@abaya/domain';
import { FEATURE_FIELDS, planTitle } from '@abaya/knowledge';
import type { Plan } from '../../catalog/catalog.js';

/**
 * Textos fijos (sección 6.3.4): el modelo NUNCA los escribe; los inserta el código.
 *
 * BORRADOR: textos de ejemplo pendientes de aprobación de Claro (preguntas 16 y 17).
 * En particular AUTORIZACION debe reemplazarse por el texto legal oficial, palabra por
 * palabra. La versión del texto queda registrada vía hash en ConsentEvidence.
 */
export const TEMPLATE_VERSION = 'borrador-2026-10-05';

/** Menú inicial (v1.8): saludo de la configuración del agente + opciones A–D fijas. */
export const menu = menuText;

export const MENU = menu(DEFAULT_AGENT_CONFIG.welcome);

/**
 * Opciones C y D del menú (D-003). Como en Dapta, el chat NO se cierra: termina preguntando si
 * puede ayudar con un plan. Si responde que no, se despide y cierra como soporte.
 */
export const SUPPORT =
  'En este momento no cuento con las herramientas para ayudarte con eso, ya que este es un ' +
  'chat exclusivo de ventas de planes pospago. Puedes comunicarte al *611 desde tu celular ' +
  'Claro, en Bogotá al 6017500500 o a nivel nacional al 018003200200. ¿Te puedo ayudar con ' +
  'algún plan móvil?';

/** Pregunta del nombre justo después de elegir la opción del menú (D-003). */
export function askName(option: 'A' | 'B'): string {
  return option === 'A'
    ? '¡Excelente decisión! 😊 ¿Con quién tengo el gusto?'
    : '¡Perfecto! 😊 ¿Con quién tengo el gusto?';
}

/** Primer nombre del cliente para los textos fijos (sin cifras ni símbolos). */
export function firstName(name: string | undefined): string | undefined {
  const n = name
    ?.trim()
    .split(/\s+/)[0]
    ?.replace(/[^\p{L}'-]/gu, '');
  return n ? n.charAt(0).toLocaleUpperCase('es-CO') + n.slice(1) : undefined;
}
const withName = (prefix: string, name: string | undefined, rest: string) =>
  `${prefix}${firstName(name) ? `, ${firstName(name)}` : ''}${rest}`;

export const SAFE_FALLBACK =
  'Déjame confirmarte ese detalle para darte la información correcta. ¿Me lo puedes ' +
  'repetir, por favor?';

/** Tras el «SÍ AUTORIZO»: transferencia al backoffice (D-003). */
export const transfer = (name?: string) =>
  withName(
    '¡Gracias',
    name,
    '! Te transfiero con uno de nuestros asesores para finalizar tu solicitud. 🚀',
  );

/** Si el cliente no autoriza: se le ofrece un asesor antes de cerrar (D-003). */
export const declinedAuthorization = (name?: string) =>
  withName(
    'Entiendo',
    name,
    '. Sin esta autorización no podemos continuar con la contratación. ¿Quieres que un asesor te resuelva las dudas que tengas sobre este paso?',
  );

/** Aceptó hablar con un asesor después de no autorizar. */
export const advisorAfterDecline = (name?: string) =>
  withName(
    '¡Con gusto',
    name,
    '! Te comunico con uno de nuestros asesores para resolver tus dudas. 🚀',
  );

export const NO_SALE_GOODBYE = '¡Gracias por contactar a Claro! Que tengas un excelente día. 👋';

export const ESCALATE =
  'Gracias por tu mensaje. Te voy a comunicar con un asesor de nuestro equipo que podrá ' +
  'ayudarte mejor con esto. Por favor espera un momento.';

/** Fecha y hora de Bogotá en formato legible (para la autorización). */
export function bogotaDateTime(d: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(d);
}

/** TEXTO LEGAL DE EJEMPLO — reemplazar por el oficial de Claro (pregunta 17). */
export function authorization(now: Date): string {
  return (
    '*Autorización de consulta y tratamiento de datos* (TEXTO DE EJEMPLO, PENDIENTE DE ' +
    'APROBACIÓN)\n\n' +
    'Para continuar con tu solicitud necesitamos tu autorización para consultar tu ' +
    'información en centrales de riesgo conforme a la Ley 1266 de 2008, y para el ' +
    'tratamiento de tus datos personales conforme a la Ley 1581 de 2012, con la ' +
    'finalidad de estudiar y gestionar tu solicitud.\n\n' +
    `Fecha y hora: ${bogotaDateTime(now)} (hora de Bogotá).\n\n` +
    'Responde *SÍ AUTORIZO* para continuar o *NO* si no deseas autorizar.'
  );
}

export function formatCop(value: number): string {
  return '$' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(value);
}

/**
 * Ficha oficial de un plan (v1.9): título, columnas de texto del catálogo y precio, LITERALES
 * del registro publicado. El modelo nunca la escribe: pone {{OFERTA:CÓDIGO}} y el código la
 * inserta (regla 11).
 */
export function offer(p: Plan): string {
  const lines = [`*${planTitle(p)}*`];
  for (const [key, label] of FEATURE_FIELDS) {
    const v = p[key];
    if (v) lines.push(`• ${label}: ${v}`);
  }
  lines.push(`• Valor: *${formatCop(p.priceCop)}* al mes`);
  if (p.discountText) lines.push(`_${p.discountText}_`);
  return lines.join('\n');
}

/** Respaldo determinista cuando hay que mostrar la oferta y el modelo no eligió plan. */
export function offerList(plans: Plan[]): string {
  return (
    'Estos son los planes disponibles para ti:\n\n' +
    plans.map(offer).join('\n\n') +
    '\n\n¿Cuál te gustaría?'
  );
}

/** Marcadores que el modelo puede escribir y el código reemplaza (sección 6.3.4). */
export const MARKER_RE =
  /\{\{(OFERTA):([A-Z][A-Z0-9]{0,9})\}\}|\{\{(AUTORIZACION|MENU|SOPORTE)\}\}/g;

export function extractMarkers(reply: string): { offers: string[]; others: string[] } {
  const offers: string[] = [];
  const others: string[] = [];
  for (const m of reply.matchAll(MARKER_RE)) {
    if (m[1] === 'OFERTA') offers.push(m[2]!);
    else others.push(m[3]!);
  }
  return { offers, others };
}

export function stripMarkers(reply: string): string {
  return reply.replace(MARKER_RE, '');
}
