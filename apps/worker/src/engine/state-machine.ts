import {
  DEFAULT_FLOW,
  processForOption,
  type AgentFlow,
  type OutOfScopeStage,
  type Stage,
} from '@abaya/domain';
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

/**
 * Proceso al que lleva una opción del menú (D-015: lo define el flujo del agente; por defecto
 * A portabilidad, B migración, C y D «preguntar qué necesita»). E = línea nueva, solo si el
 * cliente dice explícitamente que quiere una línea o un número nuevo.
 */
export function optionProcess(
  o: MenuOption,
  flow: AgentFlow = DEFAULT_FLOW,
): SaleProcess | undefined {
  return processForOption(flow, o);
}

/** Opciones del menú que no llevan a un proceso de venta (se pregunta qué necesita). */
export const isSupportOption = (o: MenuOption, flow: AgentFlow = DEFAULT_FLOW) =>
  !optionProcess(o, flow);

/**
 * Datos para poder ofrecer. D-013: el nombre ya no es requisito: la asesora no lo pide antes de
 * ofrecer; el cliente lo da completo con sus datos tras autorizar (si lo dice antes, se guarda).
 * D-015: los datos de cada proceso los define el flujo del agente.
 */
export function missingProfileFields(
  p: Profile,
  flow: AgentFlow = DEFAULT_FLOW,
): (keyof Profile)[] {
  if (!p.process) return ['process'];
  return flow.processes[p.process].asks.filter((k) => !p[k]);
}

export interface TransitionInput {
  stage: Stage;
  intent: Intent;
  option?: MenuOption;
  /** Perfil ya fusionado con lo extraído en este turno. */
  profile: Profile;
  /** Código de plan aceptado, ya validado contra el catálogo. */
  acceptedPlanCode?: string;
  /** D-015: flujo del agente (por defecto, el de la campaña). */
  flow?: AgentFlow;
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
  const flow = i.flow ?? DEFAULT_FLOW;
  // D-015: qué hacer con lo que está fuera de alcance lo define el flujo por etapa. SOPORTE =
  // plantilla de soporte (chat exclusivo de ventas) y la conversación sigue; ESCALAR = asesor.
  if (intent === 'FUERA_DE_ALCANCE') {
    const action = flow.outOfScope[stage as OutOfScopeStage] ?? 'ESCALAR';
    return { ok: true, to: action === 'SOPORTE' ? 'SOPORTE' : 'ESCALAR' };
  }

  switch (stage) {
    case 'MENU':
      if (intent === 'ELIGE_OPCION') {
        if (!i.option) return { ok: false, reason: 'ELIGE_OPCION sin opción' };
        return { ok: true, to: isSupportOption(i.option, flow) ? 'SOPORTE' : 'PERFIL' };
      }
      if (intent === 'NO_INTERESADO') return { ok: true, to: 'CIERRE_SIN_VENTA' };
      return { ok: true, to: 'MENU' };

    case 'PERFIL':
      if (intent === 'NO_INTERESADO') return { ok: true, to: 'CIERRE_SIN_VENTA' };
      if (intent === 'OBJECION') return { ok: true, to: 'PERFIL' };
      return {
        ok: true,
        to: missingProfileFields(i.profile, flow).length === 0 ? 'OFERTA' : 'PERFIL',
      };

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
