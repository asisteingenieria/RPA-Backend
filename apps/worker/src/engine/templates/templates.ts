import {
  DEFAULT_AGENT_CONFIG,
  TEMPLATE_MARKER_RE,
  menuText,
  renderTemplate,
  systemTemplates,
  templateByRole,
  templatesByRole,
  type AgentConfig,
  type FlowProcess,
  type SystemTemplateRole,
} from '@abaya/domain';
import { FEATURE_FIELDS, planTitle } from '@abaya/knowledge';
import type { Plan } from '../../catalog/catalog.js';
import { discountedPriceCop } from '../validators/figures.js';

/**
 * Textos fijos (sección 6.3.4): el modelo NUNCA los escribe; los inserta el código.
 *
 * D-007: la autorización es el texto del guion de Dapta que hoy usa la campaña, palabra por
 * palabra (con la fecha de Bogotá en el lugar de {{fecha_actual}}). Sigue pendiente la
 * confirmación escrita de Claro (pregunta 17). La versión del texto queda registrada vía hash
 * en ConsentEvidence.
 */
export const TEMPLATE_VERSION = 'dapta-2026-10-08';

/** Menú inicial (v1.8): saludo de la configuración del agente + opciones del flujo (D-015). */
export const menu = (agent: Pick<AgentConfig, 'welcome' | 'flow'>) =>
  menuText(agent.welcome, agent.flow);

export const MENU = menu(DEFAULT_AGENT_CONFIG);

/**
 * D-015: texto de una plantilla del sistema del agente (o la de la campaña si no la tiene), con
 * sus variables. Para ESPERA, la primera; `holdingTexts` las da todas.
 */
export function systemText(
  agent: Pick<AgentConfig, 'templates' | 'agentName'>,
  role: SystemTemplateRole,
  name?: string,
  now: Date = new Date(),
  /** DATOS_FALTANTES: lo que falta, ya redactado. */
  missingData?: string,
): string {
  const t = systemTemplates(agent.templates, role)[0]!;
  return renderTemplate(t.text, {
    agentName: agent.agentName,
    customerName: firstName(name),
    now,
    ...(missingData ? { missingData } : {}),
  });
}

/** Texto por defecto (el de la campaña) de una plantilla del sistema. */
const defaultText = (role: SystemTemplateRole, name?: string) =>
  systemText(DEFAULT_AGENT_CONFIG, role, name);

/**
 * Opciones C y D del menú (D-003). Como en Dapta, el chat NO se cierra: termina preguntando si
 * puede ayudar con un plan. Si responde que no, se despide y cierra como soporte. D-015: plantilla
 * SOPORTE del agente; esta constante es el texto de la campaña.
 */
export const SUPPORT = defaultText('SOPORTE');

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
/**
 * D-009: si el cliente lleva un rato esperando respuesta (cola, modelo lento), el sistema le
 * avisa que sigue atendido. Se rotan para no repetir el mismo texto. D-015: plantillas ESPERA.
 */
export function holdingTexts(
  agent: Pick<AgentConfig, 'templates' | 'agentName'>,
  now: Date = new Date(),
): string[] {
  return systemTemplates(agent.templates, 'ESPERA').map((t) =>
    renderTemplate(t.text, { agentName: agent.agentName, now }),
  );
}
export const HOLDING_MESSAGES = holdingTexts(DEFAULT_AGENT_CONFIG);

export const SAFE_FALLBACK = defaultText('RESPUESTA_SEGURA');

/** D-010: nota de voz que no se pudo transcribir (ruido, muy larga, sin audio, error). */
export const VOICE_UNREADABLE = defaultText('NOTA_DE_VOZ_ILEGIBLE');

/** D-010: la autorización queda por escrito; un «sí» en una nota de voz no cuenta. */
export const CONSENT_IN_WRITING = defaultText('AUTORIZACION_POR_ESCRITO');

/** Respuesta ambigua a la autorización: solo vale un SÍ o un NO explícito. */
export const CONFIRM_AUTHORIZATION = defaultText('CONFIRMAR_AUTORIZACION');

/** D-011: texto de la primera imagen de planes (sin cifras: los precios están en la imagen). */
export function plansImagesCaption(process: 'PORTABILIDAD' | 'MIGRACION' | 'LINEA_NUEVA'): string {
  const what = {
    PORTABILIDAD: 'para pasarte a Claro con tu mismo número',
    MIGRACION: 'para pasarte de prepago a pospago',
    LINEA_NUEVA: 'para tu línea nueva',
  }[process];
  return `Te comparto nuestros planes ${what} 👇`;
}

/** D-011: texto de las imágenes de los demás planes (si no aceptó el primero). */
export const MORE_PLANS_CAPTION = 'Te comparto también estas otras opciones 👇';

/** Tras el «SI» a la autorización: transferencia al backoffice (D-003). D-015: TRANSFERENCIA. */
export const transfer = (name?: string) => defaultText('TRANSFERENCIA', name);

/** Si el cliente no autoriza: se le ofrece un asesor antes de cerrar (D-003). D-015: NO_AUTORIZA. */
export const declinedAuthorization = (name?: string) => defaultText('NO_AUTORIZA', name);

/** Aceptó hablar con un asesor después de no autorizar. D-015: ASESOR_TRAS_NO_AUTORIZAR. */
export const advisorAfterDecline = (name?: string) => defaultText('ASESOR_TRAS_NO_AUTORIZAR', name);

export const NO_SALE_GOODBYE = '¡Gracias por contactar a Claro! Que tengas un excelente día. 👋';

export const ESCALATE = defaultText('ESCALAR');

/** Fecha y hora de Bogotá en formato legible (para la autorización). */
export function bogotaDateTime(d: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(d);
}

/** Autorización de consulta de datos (D-007: texto del guion de Dapta de la campaña). */
export function authorization(now: Date): string {
  return (
    'Con el fin de continuar con la contratación de los servicios informados, siendo hoy ' +
    `${bogotaDateTime(now)}, ¿autorizas a Claro para consultar tu documento de identidad ante ` +
    'cualquier fuente y/o reporte en cualquier operador de información, tu comportamiento y ' +
    'crédito comercial, hábito de pago y en general el cumplimiento de tus obligaciones ' +
    'comerciales y pecuniarias, así como el tratamiento de tus datos personales, según lo ' +
    'dispuesto en la Ley 1266 de 2008 y la Ley 1581 de 2012? Responde *SI* o *NO*.'
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
  const discounted = discountedPriceCop(p);
  if (discounted !== null) lines.push(`• Con el descuento pagas *${formatCop(discounted)}* al mes`);
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
  /\{\{(OFERTA|DETALLE):([A-Z][A-Z0-9]{0,9})\}\}|\{\{(AUTORIZACION|MENU|SOPORTE)\}\}/g;

export function extractMarkers(reply: string): {
  offers: string[];
  /** {{DETALLE:CODIGO}}: descripción de un plan concreto que el cliente pidió explicar. */
  details: string[];
  others: string[];
} {
  const offers: string[] = [];
  const details: string[] = [];
  const others: string[] = [];
  for (const m of reply.matchAll(MARKER_RE)) {
    if (m[1] === 'OFERTA') offers.push(m[2]!);
    else if (m[1] === 'DETALLE') details.push(m[2]!);
    else others.push(m[3]!);
  }
  return { offers, details, others };
}

/** «a, b, c» → «a, b y c» (si no trae ya la conjunción). */
function joinNatural(text: string): string {
  return /\s(y|e)\s/i.test(text) ? text : text.replace(/,\s*([^,]+)$/, ' y $1');
}

/** «Claro-video + prime video + Claro-música + Claro-música» → sin guiones ni repetidos. */
function includesList(text: string): string {
  const seen = new Set<string>();
  return text
    .replace(/Claro-/gi, 'Claro ')
    .split('+')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => {
      const k = x.toLowerCase();
      if (!x || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(' + ');
}

/** Quita el rótulo de la tarjeta («App que podrá seguir usando, finalizados los datos del plan»). */
function appsList(text: string): string {
  return text
    .replace(
      /app\s+que\s+podr[aá]\s+seguir\s+usando,?\s*finalizados\s+los\s+datos\s+del\s+plan:?/i,
      '',
    )
    .replace(/\s*al\s+agotar\s+los\s+datos\s+del\s+plan\.?/i, '')
    .trim();
}

/**
 * Descripción de un plan concreto con el formato de la campaña («Descripción del plan» de las
 * plantillas de Claro), armada por el código con los datos del registro publicado: el modelo
 * nunca escribe estas cifras. Solo incluye lo que trae el plan.
 */
export function planDescription(p: Plan): string {
  const lines: string[] = [];
  if (p.callsText) {
    const calls = p.callsText.replace(/\s+/g, ' ').trim();
    const ldi = /LDI\s+(.+)$/i.exec(calls)?.[1];
    lines.push(
      /ilimitad/i.test(calls) && /nacional/i.test(calls)
        ? `👉🏻 MINUTOS Y MENSAJES ILIMITADOS a cualquier operador y destino nacional en Colombia${ldi ? `, más larga distancia internacional a ${ldi.toUpperCase()}` : ''}. 📲`
        : `👉🏻 ${calls}. 📲`,
    );
  }
  const unlimited = /ilimitad/i.test(p.dataText);
  lines.push(
    `👉🏻 ${unlimited ? 'NAVEGACIÓN ILIMITADA' : `${p.dataText.toUpperCase()} DE NAVEGACIÓN`} en internet${
      p.sharedDataText
        ? `, y puedes compartir ${/\d+(?:[.,]\d+)?\s*GB/i.exec(p.sharedDataText)?.[0].toUpperCase() ?? p.sharedDataText} de internet`
        : ''
    }. 🤩`,
  );
  const apps = p.unlimitedAppsText ? appsList(p.unlimitedAppsText) : '';
  if (apps)
    lines.push(`👉🏻 Sigues usando ${joinNatural(apps)} aunque se acaben los datos del plan. 🔓`);
  if (p.includesText) lines.push(`👉🏻 Incluye ${includesList(p.includesText)}. 🎞️`);
  lines.push(`Cargo fijo mensual: *${formatCop(p.priceCop)}* IVA incluido`);
  // D-016: el descuento del plan, tal como se escribió en el Brain (p. ej. «✅Descuento del 25%…»).
  if (p.discountText) lines.push(p.discountText);
  return lines.join('\n\n');
}

export function stripMarkers(reply: string): string {
  return reply.replace(MARKER_RE, '').replace(TEMPLATE_MARKER_RE, '').replace(IMAGE_MARKER_RE, '');
}

// ---------- D-013: plantillas de la campaña (versionadas con el agente) ----------

/** Ids de las plantillas que el modelo pidió con {{PLANTILLA:id}}. */
export function templateMarkers(reply: string): string[] {
  return [...reply.matchAll(TEMPLATE_MARKER_RE)].map((m) => m[1]!);
}

export const templateVars = (agent: AgentConfig, name: string | undefined, now: Date) => ({
  agentName: agent.agentName,
  customerName: firstName(name),
  now,
});

/** Reemplaza cada {{PLANTILLA:id}} por el texto exacto de la plantilla (con sus variables). */
export function renderTemplateMarkers(
  reply: string,
  agent: AgentConfig,
  name: string | undefined,
  now: Date,
): string {
  const byId = new Map(templatesByRole(agent.templates, 'RESPUESTA').map((t) => [t.id, t]));
  return reply.replace(TEMPLATE_MARKER_RE, (m, id: string) => {
    const t = byId.get(id);
    return t ? renderTemplate(t.text, templateVars(agent, name, now)) : m;
  });
}

// ---------- D-014: ofrecer con imágenes ----------

/** {{IMAGENES}} = imágenes de planes del proceso; {{IMAGENES_VIDEO}} = circular de apps de video. */
export const IMAGE_MARKER_RE = /\{\{IMAGENES(_VIDEO)?\}\}/g;

export function imageMarkers(reply: string): { plans: boolean; video: boolean } {
  const found = [...reply.matchAll(IMAGE_MARKER_RE)];
  return { plans: found.some((m) => !m[1]), video: found.some((m) => !!m[1]) };
}

export function stripImageMarkers(reply: string): string {
  return reply
    .replace(IMAGE_MARKER_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n');
}

/**
 * Texto de autorización que se muestra (D-013: la plantilla AUTORIZACION del agente, con la fecha
 * del día) y su versión para la evidencia. Sin plantilla, el texto anterior (D-007).
 */
export function authorizationFor(
  agent: AgentConfig,
  now: Date,
): { text: string; version: string; intro: string | null } {
  const legal = templateByRole(agent.templates, 'AUTORIZACION');
  const intro = templateByRole(agent.templates, 'INTRO_AUTORIZACION');
  const vars = { agentName: agent.agentName, now };
  return legal
    ? {
        text: renderTemplate(legal.text, vars),
        version: `agente-${agent.id}:${legal.id}`,
        intro: intro ? renderTemplate(intro.text, vars) : null,
      }
    : { text: authorization(now), version: TEMPLATE_VERSION, intro: null };
}

/** Opciones C/D: antes de mandar los canales de soporte se le pregunta qué necesita (D-015: PREGUNTA_NECESIDAD). */
export const ASK_NEED = defaultText('PREGUNTA_NECESIDAD');

/**
 * D-013: primera pregunta tras elegir el proceso, como en la venta grabada (A → «¿con qué
 * operador…?», B → el uso). D-015: la plantilla de cada proceso la define el flujo del agente.
 * null si el proceso no tiene o el agente no tiene esa plantilla.
 */
export function firstQuestionFor(
  agent: AgentConfig,
  process: FlowProcess,
  now: Date,
): string | null {
  const id = agent.flow.processes[process].firstTemplate;
  const t = id ? agent.templates.find((x) => x.id === id) : undefined;
  return t ? renderTemplate(t.text, { agentName: agent.agentName, now }) : null;
}

/** D-013: pedido de datos tras el «SÍ» (null = se transfiere de una vez, como antes). */
export function dataRequestFor(agent: AgentConfig, name: string | undefined, now: Date) {
  const t = templateByRole(agent.templates, 'SOLICITUD_DATOS');
  return t ? renderTemplate(t.text, templateVars(agent, name, now)) : null;
}

/** D-013: despedida sin venta de la campaña (o la del código si no hay). */
export function noSaleGoodbyeFor(agent: AgentConfig, now: Date): string {
  const t = templateByRole(agent.templates, 'DESPEDIDA_NO_VENTA');
  return t ? renderTemplate(t.text, { agentName: agent.agentName, now }) : NO_SALE_GOODBYE;
}

/** D-013: textos de reactivación en orden. */
export function reactivationTexts(agent: AgentConfig, now: Date): string[] {
  return templatesByRole(agent.templates, 'REACTIVACION').map((t) =>
    renderTemplate(t.text, { agentName: agent.agentName, now }),
  );
}
