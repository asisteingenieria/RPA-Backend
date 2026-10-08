import type { Stage } from '@abaya/domain';
import type { Intent, MenuOption, Profile, SaleProcess } from './types.js';

/**
 * Máquina de estados del flujo de venta (sección 6.3.2). Las transiciones las decide el
 * CÓDIGO a partir de la intención que devuelve el modelo (regla 12).
 */

export const TERMINAL_STAGES: ReadonlySet<Stage> = new Set([
  'SOPORTE',
  'TRANSFERENCIA',
  'CIERRE_SIN_VENTA',
  'ESCALAR',
]);

/** Intenciones aceptables en cada estado. Cualquier otra se rechaza (validador 5). */
export const ALLOWED_INTENTS: Record<Stage, readonly Intent[]> = {
  MENU: ['ELIGE_OPCION', 'PREGUNTA', 'NO_INTERESADO', 'FUERA_DE_ALCANCE'],
  PERFIL: ['DA_DATO', 'PREGUNTA', 'OBJECION', 'NO_INTERESADO', 'FUERA_DE_ALCANCE'],
  OFERTA: ['PREGUNTA', 'OBJECION', 'ACEPTA_PLAN', 'NO_INTERESADO', 'DA_DATO', 'FUERA_DE_ALCANCE'],
  OBJECIONES: [
    'PREGUNTA',
    'OBJECION',
    'ACEPTA_PLAN',
    'NO_INTERESADO',
    'DA_DATO',
    'FUERA_DE_ALCANCE',
  ],
  AUTORIZACION: ['AUTORIZA', 'NO_AUTORIZA', 'PREGUNTA'],
  TRANSFERENCIA: [],
  SOPORTE: [],
  CIERRE_SIN_VENTA: [],
  ESCALAR: [],
};

/** Opciones del menú que llevan a una venta (D-003). C y D son soporte: fuera de alcance. */
export const OPTION_PROCESS: Partial<Record<MenuOption, SaleProcess>> = {
  A: 'PORTABILIDAD',
  B: 'MIGRACION',
};

/** Opciones del menú que se atienden con el mensaje de soporte y cierran el chat. */
export const isSupportOption = (o: MenuOption) => !OPTION_PROCESS[o];

/** Datos mínimos del perfil para pasar a OFERTA, por proceso. */
export const REQUIRED_PROFILE: Record<SaleProcess, readonly (keyof Profile)[]> = {
  PORTABILIDAD: ['name', 'currentOperator', 'usage'],
  MIGRACION: ['name', 'usage'],
  LINEA_NUEVA: ['name', 'usage'],
};

export function missingProfileFields(p: Profile): (keyof Profile)[] {
  if (!p.process) return ['process'];
  return REQUIRED_PROFILE[p.process].filter((k) => !p[k]);
}

export interface TransitionInput {
  stage: Stage;
  intent: Intent;
  option?: MenuOption;
  /** Perfil ya fusionado con lo extraído en este turno. */
  profile: Profile;
  /** Código de plan aceptado, ya validado contra el catálogo. */
  acceptedPlanCode?: string;
}

export type Transition = { ok: true; to: Stage } | { ok: false; reason: string };

export function isIntentAllowed(stage: Stage, intent: Intent): boolean {
  return ALLOWED_INTENTS[stage].includes(intent);
}

export function transition(i: TransitionInput): Transition {
  const { stage, intent } = i;
  if (TERMINAL_STAGES.has(stage)) return { ok: false, reason: `estado terminal ${stage}` };
  if (!isIntentAllowed(stage, intent)) {
    return { ok: false, reason: `intención ${intent} no permitida en ${stage}` };
  }
  if (intent === 'FUERA_DE_ALCANCE') return { ok: true, to: 'ESCALAR' };

  switch (stage) {
    case 'MENU':
      if (intent === 'ELIGE_OPCION') {
        if (!i.option) return { ok: false, reason: 'ELIGE_OPCION sin opción' };
        return { ok: true, to: isSupportOption(i.option) ? 'SOPORTE' : 'PERFIL' };
      }
      if (intent === 'NO_INTERESADO') return { ok: true, to: 'CIERRE_SIN_VENTA' };
      return { ok: true, to: 'MENU' };

    case 'PERFIL':
      if (intent === 'NO_INTERESADO') return { ok: true, to: 'CIERRE_SIN_VENTA' };
      if (intent === 'OBJECION') return { ok: true, to: 'PERFIL' };
      return { ok: true, to: missingProfileFields(i.profile).length === 0 ? 'OFERTA' : 'PERFIL' };

    case 'OFERTA':
      if (intent === 'ACEPTA_PLAN') {
        return i.acceptedPlanCode
          ? { ok: true, to: 'AUTORIZACION' }
          : { ok: false, reason: 'ACEPTA_PLAN sin plan válido' };
      }
      // Una objeción o un "no me interesa" se trabaja primero en OBJECIONES.
      if (intent === 'OBJECION' || intent === 'NO_INTERESADO')
        return { ok: true, to: 'OBJECIONES' };
      return { ok: true, to: 'OFERTA' };

    case 'OBJECIONES':
      if (intent === 'ACEPTA_PLAN') {
        return i.acceptedPlanCode
          ? { ok: true, to: 'AUTORIZACION' }
          : { ok: false, reason: 'ACEPTA_PLAN sin plan válido' };
      }
      if (intent === 'NO_INTERESADO') return { ok: true, to: 'CIERRE_SIN_VENTA' };
      if (intent === 'OBJECION') return { ok: true, to: 'OBJECIONES' };
      // Pregunta o dato: la objeción quedó resuelta, se vuelve a la oferta.
      return { ok: true, to: 'OFERTA' };

    case 'AUTORIZACION':
      if (intent === 'AUTORIZA') return { ok: true, to: 'TRANSFERENCIA' };
      if (intent === 'NO_AUTORIZA') return { ok: true, to: 'CIERRE_SIN_VENTA' };
      return { ok: true, to: 'AUTORIZACION' };

    default:
      return { ok: false, reason: `estado desconocido ${stage}` };
  }
}

/**
 * Lectura determinista de la opción del menú: si el cliente escribió claramente A/B/C/D
 * (o 1–4), el código lo decide sin depender del modelo.
 */
export function parseMenuOption(text: string): MenuOption | undefined {
  const t = text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.!)*"']/g, '')
    .trim();
  // Las letras en círculo del menú (🅐 🅑 🅒 🅓) también cuentan.
  const circled: Record<string, string> = { '🅐': 'a', '🅑': 'b', '🅒': 'c', '🅓': 'd' };
  if (circled[t]) return circled[t]!.toUpperCase() as MenuOption;
  const m = /^(?:la\s+)?(?:opcion\s+)?([abcd1-4])$/.exec(t);
  if (!m) return undefined;
  const map: Record<string, MenuOption> = {
    a: 'A',
    b: 'B',
    c: 'C',
    d: 'D',
    1: 'A',
    2: 'B',
    3: 'C',
    4: 'D',
  };
  return map[m[1]!];
}
