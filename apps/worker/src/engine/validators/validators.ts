import { FORBIDDEN_PROMISES as DOMAIN_FORBIDDEN_PROMISES, type Stage } from '@abaya/domain';
import type { Plan } from '../../catalog/catalog.js';
import { turnOutputSchema, type TurnOutput } from '../output-schema.js';
import { isIntentAllowed } from '../state-machine.js';
import { extractMarkers, stripMarkers } from '../templates/templates.js';
import type { SaleProcess } from '../types.js';

/**
 * Validadores anti-alucinación (sección 6.3.5). Se ejecutan sobre la salida del modelo
 * ANTES de reemplazar marcadores y de enviar nada (regla 10).
 */

export const MAX_REPLY_CHARS = 600;

/** Frases que el modelo no puede prometer (lista compartida con la revisión del guion). */
export const FORBIDDEN_PROMISES = DOMAIN_FORBIDDEN_PROMISES;

export interface ValidationContext {
  stage: Stage;
  process?: SaleProcess;
  /** Planes activos y vigentes del proceso de la conversación. */
  availablePlans: Plan[];
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

const normalize = (s: string) => s.toLowerCase().normalize('NFC');

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
  const lower = normalize(text);

  // 2. Cifras prohibidas: el texto libre no lleva números, precios, GB, % ni fechas.
  if (/\d/.test(text)) errors.push('cifras: el texto no puede contener números');
  if (/[$%]/.test(text)) errors.push('cifras: el texto no puede contener "$" ni "%"');
  if (/\b(gb|gigas?|megas?|mb|cop|pesos)\b/i.test(text)) {
    errors.push('cifras: el texto no puede mencionar GB, megas ni pesos');
  }

  // 3. Catálogo: todo código de plan existe, está activo y es del proceso.
  const markers = extractMarkers(out.reply);
  const codes = new Set([...markers.offers, ...(out.planCode ? [out.planCode] : [])]);
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
  if (out.intent === 'ACEPTA_PLAN' && !out.planCode) {
    errors.push('catálogo: ACEPTA_PLAN requiere planCode');
  }

  // 4. Promesas prohibidas.
  for (const phrase of FORBIDDEN_PROMISES) {
    if (lower.includes(phrase)) errors.push(`promesa prohibida: "${phrase}"`);
  }

  // 5. Transición: la intención debe ser válida en el estado actual.
  if (!isIntentAllowed(ctx.stage, out.intent)) {
    errors.push(`transición: intención ${out.intent} no permitida en ${ctx.stage}`);
  }
  if (out.intent === 'ELIGE_OPCION' && !out.option) {
    errors.push('transición: ELIGE_OPCION requiere option');
  }

  // 6. Longitud y formato WhatsApp.
  if (out.reply.length > MAX_REPLY_CHARS)
    errors.push(`formato: más de ${MAX_REPLY_CHARS} caracteres`);
  if (/\*\*|__|^#+\s/m.test(out.reply))
    errors.push('formato: usar *negrita* de WhatsApp, no Markdown');
  if (/https?:\/\/|www\./i.test(out.reply)) errors.push('formato: no se permiten enlaces');
  if (!text.trim() && !markers.offers.length) errors.push('formato: respuesta vacía');

  return errors.length ? { ok: false, errors, output: out } : { ok: true, output: out };
}
