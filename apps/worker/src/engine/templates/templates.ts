import type { Plan } from '../../catalog/catalog.js';

/**
 * Textos fijos (sección 6.3.4): el modelo NUNCA los escribe; los inserta el código.
 *
 * BORRADOR: textos de ejemplo pendientes de aprobación de Claro (preguntas 16 y 17).
 * En particular AUTORIZACION debe reemplazarse por el texto legal oficial, palabra por
 * palabra. La versión del texto queda registrada vía hash en ConsentEvidence.
 */
export const TEMPLATE_VERSION = 'borrador-2026-10-05';

export const MENU =
  '¡Hola! 👋 Soy el asistente virtual de ventas. ¿En qué te puedo ayudar hoy?\n\n' +
  '*A.* Traer tu número desde otro operador (portabilidad)\n' +
  '*B.* Pasar tu línea prepago a un plan pospago (migración)\n' +
  '*C.* Adquirir una línea nueva\n' +
  '*D.* Soporte o consultas sobre tu servicio actual\n\n' +
  'Responde con la letra de la opción.';

export const SUPPORT =
  'Para soporte o consultas sobre tu servicio actual, comunícate con nuestra línea de ' +
  'atención marcando *611 desde tu celular. ¡Allí te ayudarán con gusto! 😊';

export const SAFE_FALLBACK =
  'Déjame confirmarte ese detalle para darte la información correcta. ¿Me lo puedes ' +
  'repetir, por favor?';

export const TRANSFER =
  '¡Listo! ✅ Ya registré tu solicitud. Un asesor de nuestro equipo continuará con el ' +
  'proceso y se comunicará contigo por este mismo chat. ¡Gracias por elegirnos!';

export const NO_SALE_GOODBYE =
  'Entiendo, gracias por tu tiempo. Si más adelante quieres conocer nuestros planes, ' +
  'escríbenos por este medio. ¡Que tengas un excelente día!';

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

export function offer(p: Plan): string {
  const lines = [
    `*${p.name}*`,
    `• ${p.dataGb} GB de navegación`,
    `• Valor: *${formatCop(p.priceCop)}* al mes`,
    ...p.benefits.map((b) => `• ${b}`),
  ];
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
