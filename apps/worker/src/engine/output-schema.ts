import { z } from 'zod';
import { INTENTS } from './types.js';

/**
 * Salida estructurada de cada turno (sección 6.3.3). Se pide al proveedor con JSON Schema
 * estricto y se valida otra vez con zod antes de usarla.
 *
 * Extensión sobre el plan: `option` (letra del menú) para que la transición de MENU no
 * dependa de interpretar el texto libre.
 */
export const turnOutputSchema = z
  .object({
    intent: z.enum(INTENTS),
    reply: z.string().min(1).max(700),
    option: z.enum(['A', 'B', 'C', 'D']).nullable(),
    planCode: z.string().nullable(),
    extracted: z
      .object({
        name: z.string().max(60).nullable(),
        currentOperator: z.string().max(40).nullable(),
        usage: z.string().max(120).nullable(),
      })
      .strict(),
    confidence: z.enum(['ALTA', 'MEDIA', 'BAJA']),
  })
  .strict();

export type TurnOutput = z.infer<typeof turnOutputSchema>;

/** JSON Schema para los modos de salida estructurada de los proveedores. */
export const turnOutputJsonSchema = z.toJSONSchema(turnOutputSchema, {
  target: 'draft-2020-12',
}) as Record<string, unknown>;
