/**
 * D-015: flujo de la conversación configurable en el panel (versionado con el agente). Son listas
 * cerradas: deciden QUÉ camino toma el código en cada caso, nunca reemplazan las reglas de la
 * sección 7 (consentimiento, textos legales, cifras del catálogo, identidad del chat).
 */

/** Procesos de venta (los mismos del catálogo). */
export const FLOW_PROCESSES = ['PORTABILIDAD', 'MIGRACION', 'LINEA_NUEVA'] as const;
export type FlowProcess = (typeof FLOW_PROCESSES)[number];

/** Letras del menú inicial (el código las reconoce sin el modelo: «A», «a)», «🅐», «1»…). */
export const MENU_LETTERS = ['A', 'B', 'C', 'D'] as const;
export type MenuLetter = (typeof MENU_LETTERS)[number];

/** A qué lleva una opción del menú: un proceso de venta o preguntar qué necesita. */
export const MENU_ACTIONS = [...FLOW_PROCESSES, 'PREGUNTAR_NECESIDAD'] as const;
export type MenuAction = (typeof MENU_ACTIONS)[number];

/** Datos del cliente que se pueden exigir antes de ofrecer (el nombre llega con los datos). */
export const PROFILE_FIELDS = ['currentOperator', 'usage'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Etapas en las que el modelo puede decir que un mensaje está fuera de alcance. */
export const OUT_OF_SCOPE_STAGES = ['MENU', 'PERFIL', 'OFERTA', 'OBJECIONES'] as const;
export type OutOfScopeStage = (typeof OUT_OF_SCOPE_STAGES)[number];

/**
 * Qué hace el código con un mensaje fuera de alcance: SOPORTE = plantilla de soporte (chat
 * exclusivo de ventas) y la conversación sigue en la misma etapa; ESCALAR = pasa a un asesor.
 */
export const OUT_OF_SCOPE_ACTIONS = ['SOPORTE', 'ESCALAR'] as const;
export type OutOfScopeAction = (typeof OUT_OF_SCOPE_ACTIONS)[number];

/**
 * Orden de las imágenes de planes de un proceso: PROPIAS_PRIMERO = primero las imágenes propias del
 * proceso (la del plan más caro primero) y después las compartidas con otros procesos; PRECIO =
 * primero la del plan más caro, propia o compartida; CARGA = en el orden en que se cargaron.
 */
export const IMAGE_ORDERS = ['PROPIAS_PRIMERO', 'PRECIO', 'CARGA'] as const;
export type ImageOrder = (typeof IMAGE_ORDERS)[number];

/**
 * Imágenes compartidas con otros procesos: CON_LAS_DEMAS = se ofrecen como las propias (según el
 * orden); SI_PIDE_PLATAFORMA = solo cuando el cliente nombra una plataforma que incluyen sus planes
 * (p. ej. Prime Video), como la circular de apps de video; SI_USO_LABORAL (D-024) = solo si el
 * cliente dice que usará el plan para el trabajo, y entonces van primero; si no, sus planes no se
 * ofrecen.
 */
export const SHARED_IMAGE_MODES = [
  'CON_LAS_DEMAS',
  'SI_PIDE_PLATAFORMA',
  'SI_USO_LABORAL',
] as const;
export type SharedImageMode = (typeof SHARED_IMAGE_MODES)[number];

/**
 * Datos del cliente que se piden tras el «SÍ» (13/10/2026): la venta pasa al backoffice cuando
 * están todos (o tras varios recordatorios sin datos nuevos, para no perderla).
 */
export const SALE_DATA_FIELDS = ['DOCUMENTO', 'NOMBRE', 'CORREO', 'CELULAR'] as const;
export type SaleDataField = (typeof SALE_DATA_FIELDS)[number];

/** Cómo se nombra cada dato en el mensaje que pide lo que falta. */
export const SALE_DATA_LABEL: Record<SaleDataField, string> = {
  DOCUMENTO: 'tu número de documento de identidad',
  NOMBRE: 'tu nombre completo',
  CORREO: 'tu correo electrónico',
  CELULAR: 'tu número celular',
};

/** Tipo de línea del cliente con su operador actual (lo extrae el modelo; decide el código). */
export const LINE_TYPES = ['PREPAGO', 'POSPAGO'] as const;
export type LineType = (typeof LINE_TYPES)[number];

/**
 * D-021: qué hace el código con un cliente propio (pospago) que eligió cambiarse de operador:
 * YA_POSPAGO = plantilla del sistema que le aclara que no aplica y le ofrece la opción de «ya
 * tengo plan»; la conversación vuelve al menú. SEGUIR = no se revisa.
 */
export const OWN_POSTPAID_ACTIONS = ['YA_POSPAGO', 'SEGUIR'] as const;
export type OwnPostpaidAction = (typeof OWN_POSTPAID_ACTIONS)[number];

/**
 * D-021: el proceso se corrige con el operador que dice el cliente (14/10/2026). Eligió cambiarse
 * de operador (A) pero su línea ya es del operador propio: si es prepago, es una migración; si es
 * pospago, no es una venta. Eligió pasarse a pospago (B) pero su línea es de otro operador: es una
 * portabilidad. El modelo solo extrae el operador y el tipo de línea; el cambio lo hace el código.
 */
export interface OperatorRouting {
  /** Nombres del operador propio (p. ej. «Claro»). Vacío = no se corrige el proceso. */
  ownNames: string[];
  /** Portabilidad + línea propia prepago → este proceso (null = no cambia). */
  ownPrepaidTo: FlowProcess | null;
  /** Portabilidad + línea propia pospago. */
  ownPostpaid: OwnPostpaidAction;
  /** Migración + línea de otro operador → este proceso (null = no cambia). */
  otherOperatorTo: FlowProcess | null;
}

/**
 * D-022: el cliente pide una plataforma de video puntual (WIN, Disney+, Netflix…): OFRECER_DIRECTO =
 * en cuanto se sabe su proceso, sin perfilar, se le ofrece lo que la incluye (la circular de esa
 * plataforma); PERFILAR = el flujo normal (perfil y primera oferta del proceso).
 */
export const PLATFORM_REQUEST_MODES = ['OFRECER_DIRECTO', 'PERFILAR'] as const;
export type PlatformRequestMode = (typeof PLATFORM_REQUEST_MODES)[number];

/**
 * D-023: el cliente pregunta en el menú por una portabilidad que ya solicitó. VALIDAR = se le
 * pregunta si recibió la confirmación: si sí, no se puede verificar (plantilla de soporte); si no, se
 * le piden los datos y pasa al backoffice para validarla. SOPORTE = plantilla de soporte directo.
 */
export const PORTABILITY_INQUIRY_MODES = ['VALIDAR', 'SOPORTE'] as const;
export type PortabilityInquiryMode = (typeof PORTABILITY_INQUIRY_MODES)[number];

export interface MenuOptionConfig {
  letter: MenuLetter;
  /** Texto de la opción en el menú (sin la letra). */
  text: string;
  action: MenuAction;
}

export interface ProcessFlow {
  /** Datos que se piden antes de ofrecer, en este orden. */
  asks: ProfileField[];
  /** Plantilla (RESPUESTA) con la que se empieza al elegir el proceso; null = la del código. */
  firstTemplate: string | null;
  /** Orden de las imágenes de planes en este proceso (13/10/2026: por proceso). */
  imageOrder: ImageOrder;
  /** Cuándo se envían las imágenes compartidas con otros procesos (13/10/2026). */
  sharedImages: SharedImageMode;
}

export interface AgentFlow {
  menu: MenuOptionConfig[];
  processes: Record<FlowProcess, ProcessFlow>;
  outOfScope: Record<OutOfScopeStage, OutOfScopeAction>;
  /** Datos que deben estar antes de pasar la venta al backoffice (vacío = no se espera ninguno). */
  saleData: SaleDataField[];
  /**
   * Segundos que el robot espera en silencio a que el cliente termine de mandar sus datos (pueden
   * llegar en varios mensajes) antes de revisarlos y, si falta alguno, recordarle cuál.
   */
  saleDataWaitSeconds: number;
  /** D-021: corregir el proceso según el operador y el tipo de línea del cliente. */
  operatorRouting: OperatorRouting;
  /** D-022: qué hacer cuando el cliente pide una plataforma de video puntual. */
  platformRequest: PlatformRequestMode;
  /** D-023: consulta de una portabilidad ya solicitada. */
  portabilityInquiry: PortabilityInquiryMode;
  /**
   * D-024: palabras con las que el código reconoce que el cliente usará el plan para el trabajo
   * (en el uso que contó al perfilar). Vacío = nunca es uso laboral.
   */
  workUsageWords: string[];
}

export const FLOW_LIMITS = {
  menuText: 60,
  ownNames: 5,
  ownName: 30,
  workUsageWords: 20,
  workUsageWord: 30,
  // Por debajo del «dame un momento» de D-009 (120 s), que no debe salir mientras espera los datos.
  saleDataWaitMin: 10,
  saleDataWaitMax: 90,
} as const;

/** Letra en círculo con la que se muestra cada opción (como en la campaña). */
export const MENU_BULLET: Record<MenuLetter, string> = { A: '🅐', B: '🅑', C: '🅒', D: '🅓' };

/** El flujo de la campaña (el que el código hacía antes de D-015). */
export const DEFAULT_FLOW: AgentFlow = {
  menu: [
    { letter: 'A', text: 'Cambiarme de operador', action: 'PORTABILIDAD' },
    { letter: 'B', text: 'Pasarme de recargas a plan pospago', action: 'MIGRACION' },
    {
      letter: 'C',
      text: 'Ya tengo plan: soporte, factura o cambio',
      action: 'PREGUNTAR_NECESIDAD',
    },
    { letter: 'D', text: 'Cancelar mi plan pospago', action: 'PREGUNTAR_NECESIDAD' },
  ],
  processes: {
    // A: como la asesora, primero el operador; B: de recargas a pospago, se empieza por el uso.
    // Imágenes (13/10/2026): en Portabilidad y Migración primero las propias de la opción y
    // después las compartidas; en Línea nueva primero la del plan más caro (como en el Word).
    // Compartidas (D-024, 14/10/2026): en Portabilidad y Migración solo si el cliente usará el plan
    // para el trabajo, y entonces van primero; en Línea nueva la compartida es la oferta principal.
    PORTABILIDAD: {
      asks: ['currentOperator', 'usage'],
      firstTemplate: 'perfil-operador',
      imageOrder: 'PROPIAS_PRIMERO',
      sharedImages: 'SI_USO_LABORAL',
    },
    MIGRACION: {
      asks: ['usage'],
      firstTemplate: 'perfil-uso',
      imageOrder: 'PROPIAS_PRIMERO',
      sharedImages: 'SI_USO_LABORAL',
    },
    LINEA_NUEVA: {
      asks: ['usage'],
      firstTemplate: 'perfil-uso-directo',
      imageOrder: 'PRECIO',
      sharedImages: 'CON_LAS_DEMAS',
    },
  },
  // 13/10/2026: en el menú, lo que no es una compra recibe la plantilla de soporte.
  outOfScope: { MENU: 'SOPORTE', PERFIL: 'ESCALAR', OFERTA: 'ESCALAR', OBJECIONES: 'ESCALAR' },
  // 13/10/2026: antes de transferir deben estar el documento, el nombre completo y el correo.
  saleData: ['DOCUMENTO', 'NOMBRE', 'CORREO'],
  saleDataWaitSeconds: 45,
  // 14/10/2026: eligió A pero es de Claro prepago → migración; Claro pospago → no aplica (se le
  // ofrece la opción «ya tengo plan»); eligió B pero es de otro operador → portabilidad.
  operatorRouting: {
    ownNames: ['Claro'],
    ownPrepaidTo: 'MIGRACION',
    ownPostpaid: 'YA_POSPAGO',
    otherOperatorTo: 'PORTABILIDAD',
  },
  // 14/10/2026: pide WIN, Disney+ o Netflix → la circular de esa plataforma sin perfilar.
  platformRequest: 'OFRECER_DIRECTO',
  // 14/10/2026: «solicité una portabilidad y no sé si quedó» → ¿recibió la confirmación?
  portabilityInquiry: 'VALIDAR',
  // 14/10/2026: «más que todo para cosas laborales» → primero los planes compartidos.
  workUsageWords: ['trabajo', 'trabajar', 'laboral', 'oficina', 'negocio', 'empresa'],
};

const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Respuestas que no nombran un operador («no sé», «ninguno»…): no cuentan como otro operador. */
const NOT_AN_OPERATOR =
  /^(no|ninguno|ninguna|nada|no se|no tengo|prepago|pospago|postpago|recargas?)$/;

/** D-021: ¿el operador que dijo el cliente es el propio? («Claro», «claro colombia», «de Claro»). */
export function isOwnOperator(operator: string | undefined, flow: AgentFlow): boolean {
  if (!operator) return false;
  const said = ` ${normalizeName(operator)} `;
  return flow.operatorRouting.ownNames.some((n) => {
    const name = normalizeName(n);
    return !!name && said.includes(` ${name} `);
  });
}

/** D-021: ¿nombró un operador distinto del propio? */
export function isOtherOperator(operator: string | undefined, flow: AgentFlow): boolean {
  if (!operator || isOwnOperator(operator, flow)) return false;
  const said = normalizeName(operator);
  return !!said && !NOT_AN_OPERATOR.test(said);
}

/** D-021: a dónde lleva el operador del cliente: otro proceso, la plantilla YA_POSPAGO o nada. */
export type OperatorRoute = { to: FlowProcess } | { postpaid: true } | null;

export function routeByOperator(
  p: { process?: FlowProcess; currentOperator?: string; lineType?: LineType },
  flow: AgentFlow,
): OperatorRoute {
  const r = flow.operatorRouting;
  if (!r.ownNames.length) return null;
  if (p.process === 'PORTABILIDAD' && isOwnOperator(p.currentOperator, flow)) {
    if (p.lineType === 'PREPAGO' && r.ownPrepaidTo && r.ownPrepaidTo !== 'PORTABILIDAD')
      return { to: r.ownPrepaidTo };
    if (p.lineType === 'POSPAGO' && r.ownPostpaid === 'YA_POSPAGO') return { postpaid: true };
    return null;
  }
  if (
    p.process === 'MIGRACION' &&
    isOtherOperator(p.currentOperator, flow) &&
    r.otherOperatorTo &&
    r.otherOperatorTo !== 'MIGRACION'
  )
    return { to: r.otherOperatorTo };
  return null;
}

/**
 * D-021: falta saber si la línea propia es prepago o pospago antes de ofrecer (eligió cambiarse de
 * operador y su operador es el propio). Solo si el flujo hace algo con la respuesta.
 */
export function needsLineType(
  p: { process?: FlowProcess; currentOperator?: string; lineType?: LineType },
  flow: AgentFlow,
): boolean {
  const r = flow.operatorRouting;
  return (
    p.process === 'PORTABILIDAD' &&
    !p.lineType &&
    !!r.ownNames.length &&
    (!!r.ownPrepaidTo || r.ownPostpaid === 'YA_POSPAGO') &&
    isOwnOperator(p.currentOperator, flow)
  );
}

/**
 * D-024: ¿el uso que contó el cliente es laboral? Una palabra del flujo (o su plural) en lo que
 * dijo, salvo que vaya negada justo antes («no es para trabajo»).
 */
export function isWorkUsage(usage: string | undefined, flow: AgentFlow): boolean {
  if (!usage) return false;
  const tokens = normalizeName(usage).split(' ');
  const words = flow.workUsageWords.map(normalizeName).filter(Boolean);
  return tokens.some((t, i) => {
    const hit = words.some((w) => t === w || t === `${w}s` || t === `${w}es`);
    const negated = tokens.slice(Math.max(0, i - 3), i).some((x) => x === 'no' || x === 'ni');
    return hit && !negated;
  });
}

/** Opciones del menú tal como se envían. */
export function menuOptionsText(flow: AgentFlow): string {
  return flow.menu.map((o) => `${MENU_BULLET[o.letter]} ${o.text}`).join('\n');
}

/** Proceso al que lleva una letra (A–D del menú; E = línea nueva pedida explícitamente). */
export function processForOption(flow: AgentFlow, option: string): FlowProcess | undefined {
  if (option === 'E') return 'LINEA_NUEVA';
  const action = flow.menu.find((o) => o.letter === option)?.action;
  return action && action !== 'PREGUNTAR_NECESIDAD' ? action : undefined;
}

/** Descripción del menú para el modelo (qué significa cada letra). */
export function menuForModel(flow: AgentFlow): string {
  const label: Record<MenuAction, string> = {
    PORTABILIDAD: 'portabilidad',
    MIGRACION: 'migración',
    LINEA_NUEVA: 'línea nueva',
    PREGUNTAR_NECESIDAD: 'no es una venta directa: el sistema le pregunta qué necesita',
  };
  return flow.menu.map((o) => `${o.letter} = «${o.text}» (${label[o.action]})`).join(', ');
}

// ---------- guardado (columna JSON de AgentConfigVersion) ----------

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * Flujo de una versión guardada. Sin columna (versiones anteriores a D-015) → el de la campaña;
 * lo que falte o no se entienda se completa con el de la campaña (la revisión al guardar evita que
 * eso pase con lo que se edita en el panel).
 */
export function storedFlow(raw: unknown): AgentFlow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const menuRaw = Array.isArray(r.menu) ? (r.menu as unknown[]) : [];
  const menu = MENU_LETTERS.map((letter) => {
    const def = DEFAULT_FLOW.menu.find((o) => o.letter === letter)!;
    const o = menuRaw.find(
      (x) => !!x && typeof x === 'object' && (x as Record<string, unknown>).letter === letter,
    ) as Record<string, unknown> | undefined;
    return {
      letter,
      text: typeof o?.text === 'string' ? o.text.trim() : def.text,
      action: isOneOf(MENU_ACTIONS, o?.action) ? o.action : def.action,
    };
  });
  const procRaw = (r.processes && typeof r.processes === 'object' ? r.processes : {}) as Record<
    string,
    unknown
  >;
  const processes = Object.fromEntries(
    FLOW_PROCESSES.map((p) => {
      const def = DEFAULT_FLOW.processes[p];
      const x = (procRaw[p] && typeof procRaw[p] === 'object' ? procRaw[p] : {}) as Record<
        string,
        unknown
      >;
      const asks = Array.isArray(x.asks)
        ? PROFILE_FIELDS.filter((f) => (x.asks as unknown[]).includes(f))
        : def.asks;
      const firstTemplate =
        x.firstTemplate === null
          ? null
          : typeof x.firstTemplate === 'string'
            ? x.firstTemplate.trim() || null
            : def.firstTemplate;
      // Versiones anteriores tenían un solo orden para todos los procesos: se respeta.
      const imageOrder = isOneOf(IMAGE_ORDERS, x.imageOrder)
        ? x.imageOrder
        : isOneOf(IMAGE_ORDERS, r.imageOrder)
          ? r.imageOrder
          : def.imageOrder;
      const sharedImages = isOneOf(SHARED_IMAGE_MODES, x.sharedImages)
        ? x.sharedImages
        : def.sharedImages;
      return [p, { asks, firstTemplate, imageOrder, sharedImages }];
    }),
  ) as Record<FlowProcess, ProcessFlow>;
  const oosRaw = (r.outOfScope && typeof r.outOfScope === 'object' ? r.outOfScope : {}) as Record<
    string,
    unknown
  >;
  const outOfScope = Object.fromEntries(
    OUT_OF_SCOPE_STAGES.map((s) => [
      s,
      isOneOf(OUT_OF_SCOPE_ACTIONS, oosRaw[s]) ? oosRaw[s] : DEFAULT_FLOW.outOfScope[s],
    ]),
  ) as Record<OutOfScopeStage, OutOfScopeAction>;
  // D-021: versiones anteriores no lo tienen → el de la campaña.
  const orRaw = (
    r.operatorRouting && typeof r.operatorRouting === 'object' ? r.operatorRouting : {}
  ) as Record<string, unknown>;
  const defRouting = DEFAULT_FLOW.operatorRouting;
  const processOrNull = (v: unknown, def: FlowProcess | null) =>
    v === null ? null : isOneOf(FLOW_PROCESSES, v) ? v : def;
  const operatorRouting: OperatorRouting = {
    ownNames: Array.isArray(orRaw.ownNames)
      ? (orRaw.ownNames as unknown[])
          .filter((n): n is string => typeof n === 'string')
          .map((n) => n.trim())
          .filter(Boolean)
      : defRouting.ownNames,
    ownPrepaidTo: processOrNull(orRaw.ownPrepaidTo, defRouting.ownPrepaidTo),
    ownPostpaid: isOneOf(OWN_POSTPAID_ACTIONS, orRaw.ownPostpaid)
      ? orRaw.ownPostpaid
      : defRouting.ownPostpaid,
    otherOperatorTo: processOrNull(orRaw.otherOperatorTo, defRouting.otherOperatorTo),
  };
  return {
    menu,
    processes,
    outOfScope,
    saleData: Array.isArray(r.saleData)
      ? SALE_DATA_FIELDS.filter((f) => (r.saleData as unknown[]).includes(f))
      : DEFAULT_FLOW.saleData,
    saleDataWaitSeconds:
      typeof r.saleDataWaitSeconds === 'number' && Number.isInteger(r.saleDataWaitSeconds)
        ? r.saleDataWaitSeconds
        : DEFAULT_FLOW.saleDataWaitSeconds,
    operatorRouting,
    platformRequest: isOneOf(PLATFORM_REQUEST_MODES, r.platformRequest)
      ? r.platformRequest
      : DEFAULT_FLOW.platformRequest,
    portabilityInquiry: isOneOf(PORTABILITY_INQUIRY_MODES, r.portabilityInquiry)
      ? r.portabilityInquiry
      : DEFAULT_FLOW.portabilityInquiry,
    // D-024: versiones anteriores no la tienen → la de la campaña.
    workUsageWords: Array.isArray(r.workUsageWords)
      ? (r.workUsageWords as unknown[])
          .filter((n): n is string => typeof n === 'string')
          .map((n) => n.trim())
          .filter(Boolean)
      : DEFAULT_FLOW.workUsageWords,
  };
}

// ---------- revisión al guardar ----------

export interface FlowIssue {
  message: string;
}

/** Precios, gigas y porcentajes: no van en el menú (salen del catálogo, regla 11). */
const FIGURES =
  /\$\s*\d|\b\d{1,3}(?:[.,]\d{3})+\b|\b\d+(?:[.,]\d+)?\s*(?:gb|gigas?|megas?|mb)\b|\d+(?:[.,]\d+)?\s*%/i;

/**
 * Revisión del flujo antes de guardar. `responseTemplateIds`: ids de las plantillas RESPUESTA del
 * agente (la primera pregunta de cada proceso debe ser una de ellas).
 */
export function reviewFlow(flow: AgentFlow, responseTemplateIds: readonly string[]): FlowIssue[] {
  const issues: FlowIssue[] = [];
  for (const o of flow.menu) {
    if (!o.text.trim()) issues.push({ message: `menú: la opción ${o.letter} no tiene texto` });
    if (o.text.length > FLOW_LIMITS.menuText)
      issues.push({
        message: `menú: la opción ${o.letter} tiene más de ${FLOW_LIMITS.menuText} caracteres`,
      });
    if (FIGURES.test(o.text))
      issues.push({
        message: `menú: la opción ${o.letter} no puede llevar precios, gigas ni porcentajes`,
      });
    if (/\*\*|__|https?:\/\/|www\.|\{\{/i.test(o.text))
      issues.push({
        message: `menú: la opción ${o.letter} no admite enlaces, marcadores ni **negrita**`,
      });
  }
  if (
    flow.saleDataWaitSeconds < FLOW_LIMITS.saleDataWaitMin ||
    flow.saleDataWaitSeconds > FLOW_LIMITS.saleDataWaitMax
  )
    issues.push({
      message: `datos de la venta: la espera va entre ${FLOW_LIMITS.saleDataWaitMin} y ${FLOW_LIMITS.saleDataWaitMax} segundos`,
    });
  const routing = flow.operatorRouting;
  if (routing.ownNames.length > FLOW_LIMITS.ownNames)
    issues.push({
      message: `operador propio: máximo ${FLOW_LIMITS.ownNames} nombres`,
    });
  for (const n of routing.ownNames) {
    if (n.length > FLOW_LIMITS.ownName || FIGURES.test(n) || /\{\{|https?:\/\//i.test(n))
      issues.push({
        message: `operador propio: «${n.slice(0, 40)}» no es un nombre válido (máximo ${FLOW_LIMITS.ownName} caracteres, sin cifras ni enlaces)`,
      });
  }
  if (routing.ownPrepaidTo === 'PORTABILIDAD')
    issues.push({
      message: 'operador propio: la línea prepago no puede seguir en portabilidad',
    });
  if (routing.otherOperatorTo === 'MIGRACION')
    issues.push({
      message: 'otro operador: una línea de otro operador no puede seguir en migración',
    });
  if (flow.workUsageWords.length > FLOW_LIMITS.workUsageWords)
    issues.push({ message: `uso laboral: máximo ${FLOW_LIMITS.workUsageWords} palabras` });
  for (const w of flow.workUsageWords) {
    if (w.length > FLOW_LIMITS.workUsageWord || FIGURES.test(w) || /\{\{|https?:\/\//i.test(w))
      issues.push({
        message: `uso laboral: «${w.slice(0, 40)}» no es una palabra válida (máximo ${FLOW_LIMITS.workUsageWord} caracteres, sin cifras ni enlaces)`,
      });
  }
  if (
    flow.workUsageWords.length === 0 &&
    FLOW_PROCESSES.some((p) => flow.processes[p].sharedImages === 'SI_USO_LABORAL')
  )
    issues.push({
      message:
        'uso laboral: sin palabras, las imágenes compartidas «solo si el uso es laboral» nunca se ofrecen',
    });
  if (!flow.menu.some((o) => o.action !== 'PREGUNTAR_NECESIDAD'))
    issues.push({ message: 'menú: al menos una opción debe llevar a un proceso de venta' });
  for (const p of FLOW_PROCESSES) {
    const t = flow.processes[p].firstTemplate;
    if (t && !responseTemplateIds.includes(t))
      issues.push({
        message: `${p}: la primera pregunta «${t}» no es una plantilla de RESPUESTA del agente`,
      });
  }
  return issues;
}
