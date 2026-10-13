import {
  FORBIDDEN_PROMISES as DOMAIN_FORBIDDEN_PROMISES,
  type AgentTemplate,
  type Stage,
} from '@abaya/domain';
import type { Plan } from '../../catalog/catalog.js';
import { turnOutputSchema, type TurnOutput } from '../output-schema.js';
import { isIntentAllowed } from '../state-machine.js';
import {
  extractMarkers,
  imageMarkers,
  stripMarkers,
  templateMarkers,
} from '../templates/templates.js';
import type { SaleProcess } from '../types.js';
import { toWhatsApp, unapprovedPhrases, unverifiedFigures } from './figures.js';

/**
 * Validadores anti-alucinación (sección 6.3.5). Se ejecutan sobre la salida del modelo
 * ANTES de reemplazar marcadores y de enviar nada (regla 10). Desde D-007 las cifras no se
 * prohíben: se verifican contra el catálogo del proceso y el guion publicado (`figures.ts`).
 */

/** D-007: una lista de hasta tres planes con sus detalles cabe en un mensaje. */
export const MAX_REPLY_CHARS = 1_200;

/** Frases que el modelo no puede prometer (lista compartida con la revisión del guion). */
export const FORBIDDEN_PROMISES = DOMAIN_FORBIDDEN_PROMISES;

export interface ValidationContext {
  stage: Stage;
  process?: SaleProcess;
  /** Planes activos y vigentes del proceso de la conversación. */
  availablePlans: Plan[];
  /** D-007: textos aprobados del agente publicado (guion e información de la empresa). */
  approvedTexts?: readonly string[];
  /** D-013: plantillas que el modelo puede pedir con {{PLANTILLA:id}} (rol RESPUESTA). */
  templates?: readonly AgentTemplate[];
  /**
   * D-014: el catálogo salió de las imágenes y se ofrece SOLO con ellas ({{IMAGENES}}); las fichas
   * de texto ({{OFERTA:…}}) no se usan. Fuera de este modo, {{IMAGENES}} no existe.
   */
  imagesMode?: boolean;
  /** D-014: hay circular de apps de video para enviar con {{IMAGENES_VIDEO}}. */
  videoImages?: boolean;
}

export interface ValidationOk {
  ok: true;
  output: TurnOutput;
}
export interface ValidationFail {
  ok: false;
  errors: string[];
  output?: TurnOutput;
}

export function validateTurnOutput(
  raw: unknown,
  ctx: ValidationContext,
): ValidationOk | ValidationFail {
  // 1. Esquema.
  const parsed = turnOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `esquema: ${i.path.join('.') || '(raíz)'} ${i.message}`,
      ),
    };
  }
  const out = parsed.data;
  const errors: string[] = [];
  const text = stripMarkers(out.reply);
  const sources = { plans: ctx.availablePlans, approvedTexts: ctx.approvedTexts ?? [] };

  // 2. Cifras verificadas (D-007): cada precio, gigas, porcentaje o número del texto libre sale
  //    literal del catálogo del proceso o del guion publicado; nada más (ni fechas).
  errors.push(...unverifiedFigures(text, sources));

  // 3. Catálogo: todo código de plan existe, está activo y es del proceso.
  const markers = extractMarkers(out.reply);
  const codes = new Set([
    ...markers.offers,
    ...markers.details,
    ...(out.planCode ? [out.planCode] : []),
  ]);
  const available = new Set(ctx.availablePlans.map((p) => p.code));
  for (const code of codes) {
    if (!available.has(code)) errors.push(`catálogo: el plan ${code} no existe o no aplica`);
  }
  if (markers.others.length) {
    errors.push(`marcadores no permitidos: ${markers.others.join(', ')}`);
  }
  if (markers.offers.length && !['PERFIL', 'OFERTA', 'OBJECIONES'].includes(ctx.stage)) {
    errors.push('marcadores: no se puede ofrecer un plan en este estado');
  }
  if (markers.offers.length > 2) errors.push('marcadores: máximo dos planes por mensaje');
  if (markers.details.length && !['OFERTA', 'OBJECIONES', 'AUTORIZACION'].includes(ctx.stage)) {
    errors.push('marcadores: {{DETALLE}} solo cuando el cliente ya vio la oferta');
  }
  if (markers.details.length > 1) errors.push('marcadores: un solo {{DETALLE}} por mensaje');

  // 3a. D-014: con catálogo desde imágenes se ofrece con {{IMAGENES}}, nunca con fichas de texto.
  const images = imageMarkers(out.reply);
  if (ctx.imagesMode) {
    if (markers.offers.length) {
      errors.push('marcadores: los planes se ofrecen con {{IMAGENES}}, no con {{OFERTA:CODIGO}}');
    }
    if ((images.plans || images.video) && !['PERFIL', 'OFERTA', 'OBJECIONES'].includes(ctx.stage)) {
      errors.push('marcadores: no se pueden enviar imágenes de planes en este estado');
    }
    if (images.video && !ctx.videoImages) {
      errors.push('marcadores: no hay imagen de apps de video; no uses {{IMAGENES_VIDEO}}');
    }
  } else if (images.plans || images.video) {
    errors.push('marcadores no permitidos: IMAGENES (ofrece con {{OFERTA:CODIGO}})');
  }
  if (out.intent === 'ACEPTA_PLAN' && !out.planCode) {
    errors.push('catálogo: ACEPTA_PLAN requiere planCode');
  }

  // 3b. D-013: plantillas. Que existan, una por mensaje, y que sus cifras (p. ej. el % de un
  //     descuento) sean las del catálogo de este cliente: el texto lo inserta el código tal cual.
  const usable = new Map((ctx.templates ?? []).map((t) => [t.id, t]));
  const asked = templateMarkers(out.reply);
  if (asked.length > 1) errors.push('plantillas: máximo una plantilla por mensaje');
  for (const id of asked) {
    const t = usable.get(id);
    if (!t) {
      errors.push(`plantillas: la plantilla ${id} no existe; usa solo las de la lista`);
      continue;
    }
    if (unverifiedFigures(t.text, sources).length) {
      errors.push(
        `plantillas: ${id} tiene cifras que no coinciden con el catálogo de este cliente; no la uses y redacta con los datos de <datos_catalogo>`,
      );
    }
  }

  // 4. Promesas prohibidas, salvo que estén en el catálogo del proceso o en el guion (D-007).
  for (const phrase of unapprovedPhrases(text, sources)) {
    errors.push(`promesa prohibida: "${phrase}"`);
  }

  // 5. Transición: la intención debe ser válida en el estado actual.
  if (!isIntentAllowed(ctx.stage, out.intent)) {
    errors.push(`transición: intención ${out.intent} no permitida en ${ctx.stage}`);
  }
  if (out.intent === 'ELIGE_OPCION' && !out.option) {
    errors.push('transición: ELIGE_OPCION requiere option');
  }

  // 6. Longitud y formato WhatsApp (las **negritas** de Markdown se convierten al enviar).
  const withTemplates = out.reply.replace(
    /\{\{PLANTILLA:([a-z0-9-]+)\}\}/g,
    (m, id: string) => usable.get(id)?.text ?? m,
  );
  if (toWhatsApp(withTemplates).length > MAX_REPLY_CHARS)
    errors.push(`formato: más de ${MAX_REPLY_CHARS} caracteres`);
  if (/^#+\s/m.test(out.reply)) errors.push('formato: sin títulos de Markdown');
  if (/https?:\/\/|www\./i.test(out.reply)) errors.push('formato: no se permiten enlaces');
  if (
    !text.trim() &&
    !markers.offers.length &&
    !markers.details.length &&
    !asked.length &&
    !images.plans &&
    !images.video
  )
    errors.push('formato: respuesta vacía');

  return errors.length ? { ok: false, errors, output: out } : { ok: true, output: out };
}
