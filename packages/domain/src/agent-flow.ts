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
 * (p. ej. Prime Video), como la circular de apps de video.
 */
export const SHARED_IMAGE_MODES = ['CON_LAS_DEMAS', 'SI_PIDE_PLATAFORMA'] as const;
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
}

export const FLOW_LIMITS = {
  menuText: 60,
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
    // Compartidas: en Portabilidad y Migración solo si el cliente nombra lo que incluyen (Prime
    // Video); en Línea nueva la compartida es la oferta principal.
    PORTABILIDAD: {
      asks: ['currentOperator', 'usage'],
      firstTemplate: 'perfil-operador',
      imageOrder: 'PROPIAS_PRIMERO',
      sharedImages: 'SI_PIDE_PLATAFORMA',
    },
    MIGRACION: {
      asks: ['usage'],
      firstTemplate: 'perfil-uso',
      imageOrder: 'PROPIAS_PRIMERO',
      sharedImages: 'SI_PIDE_PLATAFORMA',
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
};

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
