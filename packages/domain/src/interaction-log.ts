/**
 * D-045: log de auditoría por interacción (requerimiento 3 de Claro). El worker registra en
 * `InteractionStep` cada paso al que entra la conversación; al exportar se deduce el resultado de
 * cada paso y se arma una fila por paso, sin datos personales (la línea va enmascarada).
 */

export const INTERACTION_STEPS = [
  'SALUDO',
  'PERFILAMIENTO',
  'OFERTA',
  'OBJECIONES',
  'LECTURA_DATOS',
  'CAPTURA_DATOS',
  'TRANSFERENCIA',
  'CIERRE_SIN_VENTA',
  'SOPORTE',
  'ESCALAMIENTO',
] as const;
export type InteractionStepName = (typeof INTERACTION_STEPS)[number];

export const STEP_RESULTS = [
  'EXITOSO',
  'ERROR',
  'ABANDONO',
  'RECHAZO',
  'CERRADA_EN_AVAYA',
  'EN_CURSO',
] as const;
export type StepResult = (typeof STEP_RESULTS)[number];

/** Nombre del paso como lo pide Claro (para el CSV). */
export const STEP_LABELS: Record<InteractionStepName, string> = {
  SALUDO: 'Saludo',
  PERFILAMIENTO: 'Perfilamiento',
  OFERTA: 'Oferta',
  OBJECIONES: 'Objeciones',
  LECTURA_DATOS: 'Lectura de tratamiento de datos',
  CAPTURA_DATOS: 'Captura de datos',
  TRANSFERENCIA: 'Transferencia',
  CIERRE_SIN_VENTA: 'Cierre sin venta',
  SOPORTE: 'Soporte (fuera de ventas)',
  ESCALAMIENTO: 'Escalamiento a asesor',
};

/** Paso al que lleva entrar a cada estado de la máquina (MENU no es un paso nuevo). */
const STAGE_STEP: Record<string, InteractionStepName | undefined> = {
  PERFIL: 'PERFILAMIENTO',
  OFERTA: 'OFERTA',
  OBJECIONES: 'OBJECIONES',
  AUTORIZACION: 'LECTURA_DATOS',
  TRANSFERENCIA: 'TRANSFERENCIA',
  CIERRE_SIN_VENTA: 'CIERRE_SIN_VENTA',
  SOPORTE: 'SOPORTE',
  ESCALAR: 'ESCALAMIENTO',
};

export interface StepEntry {
  step: InteractionStepName;
  result?: StepResult;
  detail?: string;
}

export interface TurnStepInput {
  from: string;
  to: string;
  /** D-044: en este turno se mostró la segunda lectura. */
  secondReadingShown: boolean;
  /** En este turno se pidieron los datos del cliente (después del «SÍ»). */
  dataRequested: boolean;
  /** En este turno el cliente no autorizó; número de la lectura a la que respondió. */
  declinedReading?: 1 | 2;
}

/** Pasos que deja un turno, en orden. */
export function stepsForTurn(t: TurnStepInput): StepEntry[] {
  const out: StepEntry[] = [];
  if (t.to !== t.from) {
    const step = STAGE_STEP[t.to];
    if (step) out.push(step === 'LECTURA_DATOS' ? { step, detail: '1' } : { step });
  }
  if (t.secondReadingShown) out.push({ step: 'LECTURA_DATOS', detail: '2' });
  if (t.declinedReading)
    out.push({ step: 'LECTURA_DATOS', result: 'RECHAZO', detail: String(t.declinedReading) });
  if (t.dataRequested) out.push({ step: 'CAPTURA_DATOS' });
  return out;
}

/** Celular enmascarado: los 3 primeros y los 3 últimos dígitos (300****567). */
export function maskPhone(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '').replace(/^57(?=3\d{9}$)/, '');
  if (d.length < 7) return '';
  return `${d.slice(0, 3)}****${d.slice(-3)}`;
}

export interface InteractionInput {
  id: string;
  abayaChatId: string;
  robotUser: string;
  startedAt: Date;
  /** Fin: cierre, transferencia o última actividad de una conversación terminada. */
  endedAt: Date | null;
  status: string;
  closeTag: string | null;
  phone?: string | null;
  steps: { step: string; result: string | null; detail: string | null; at: Date }[];
}

export interface InteractionRow {
  conversationId: string;
  abayaChatId: string;
  robotUser: string;
  maskedLine: string;
  startedAt: Date;
  endedAt: Date | null;
  step: InteractionStepName;
  stepLabel: string;
  reading: string;
  result: StepResult;
  stepAt: Date;
  finalStatus: string;
  closeTag: string;
  destination: string;
}

const isStep = (s: string): s is InteractionStepName =>
  (INTERACTION_STEPS as readonly string[]).includes(s);

/** Resultado del último paso según cómo terminó la conversación. */
function finalResult(status: string, closeTag: string | null): StepResult {
  switch (status) {
    case 'TRANSFERRED_BACKOFFICE':
    case 'CLOSED_SUPPORT':
      return 'EXITOSO';
    case 'NEEDS_REVIEW':
      return 'ERROR';
    case 'CLOSED_INACTIVE':
      return 'ABANDONO';
    case 'CLOSED_NO_SALE':
      return closeTag === 'NO_VENTA_ABANDONA' ? 'ABANDONO' : 'EXITOSO';
    case 'CLOSED_EXTERNALLY':
      return 'CERRADA_EN_AVAYA';
    default:
      return 'EN_CURSO';
  }
}

/** Filas del log (una por paso), con el resultado de cada paso. */
export function interactionRows(c: InteractionInput): InteractionRow[] {
  const steps: {
    step: InteractionStepName;
    result: StepResult | null;
    detail: string;
    at: Date;
  }[] = [{ step: 'SALUDO', result: null, detail: '', at: c.startedAt }];
  for (const s of c.steps) {
    if (!isStep(s.step)) continue;
    const detail = s.detail ?? '';
    const prev = steps.at(-1)!;
    const result = (STEP_RESULTS as readonly string[]).includes(s.result ?? '')
      ? (s.result as StepResult)
      : null;
    // Un resultado explícito (no autorizó) cierra el paso anterior igual, no abre otro.
    if (result && prev.step === s.step && prev.detail === detail && !prev.result) {
      prev.result = result;
      continue;
    }
    steps.push({ step: s.step, result, detail, at: s.at });
  }
  const last = steps.length - 1;
  const destination =
    c.status === 'TRANSFERRED_BACKOFFICE'
      ? 'Cola de backoffice de Avaya («Finalizar»)'
      : steps.some((s) => s.step === 'ESCALAMIENTO')
        ? 'Asesor humano (escalamiento)'
        : '';
  return steps.map((s, i) => ({
    conversationId: c.id,
    abayaChatId: c.abayaChatId,
    robotUser: c.robotUser,
    maskedLine: maskPhone(c.phone),
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    step: s.step,
    stepLabel: STEP_LABELS[s.step],
    reading: s.detail,
    result: s.result ?? (i < last ? 'EXITOSO' : finalResult(c.status, c.closeTag)),
    stepAt: s.at,
    finalStatus: c.status,
    closeTag: c.closeTag ?? '',
    destination,
  }));
}

/**
 * Conversaciones anteriores a `InteractionStep`: pasos a partir de los estados de cada llamada al
 * modelo (sin repeticiones seguidas).
 */
export function stepsFromStages(
  stages: { stage: string; at: Date }[],
): { step: string; result: null; detail: string | null; at: Date }[] {
  const out: { step: string; result: null; detail: string | null; at: Date }[] = [];
  let prev = 'MENU';
  for (const s of stages) {
    if (s.stage === prev) continue;
    const step = STAGE_STEP[s.stage];
    if (step)
      out.push({ step, result: null, detail: step === 'LECTURA_DATOS' ? '1' : null, at: s.at });
    prev = s.stage;
  }
  return out;
}
