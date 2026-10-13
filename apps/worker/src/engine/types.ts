import type { Stage } from '@abaya/domain';
import type { KnowledgeUsageRecord, PlanImageRef } from '@abaya/knowledge';

export type SaleProcess = 'PORTABILIDAD' | 'MIGRACION' | 'LINEA_NUEVA';

export const INTENTS = [
  'ELIGE_OPCION',
  'DA_DATO',
  'PREGUNTA',
  'OBJECION',
  'ACEPTA_PLAN',
  'AUTORIZA',
  'NO_AUTORIZA',
  'NO_INTERESADO',
  'FUERA_DE_ALCANCE',
] as const;
export type Intent = (typeof INTENTS)[number];

/** A–D: menú. E: línea nueva, solo si el cliente la pide explícitamente (no está en el menú). */
export type MenuOption = 'A' | 'B' | 'C' | 'D' | 'E';

/** Perfil extraído de la conversación. Vive cifrado en Conversation.profileEncrypted. */
export interface Profile {
  process?: SaleProcess;
  name?: string;
  currentOperator?: string;
  usage?: string;
  /** Plan aceptado (código validado contra el catálogo). */
  planCode?: string;
  /** Último plan ofrecido (para entender "ese", "el primero"). */
  offeredPlanCode?: string;
  /** Momento (ISO) en que se mostró el texto de autorización: permite regenerarlo exacto. */
  authorizationShownAt?: string;
  /** Versión de la plantilla legal y hash del texto exacto mostrado (evidencia, sección 8). */
  authorizationTemplateVersion?: string;
  authorizationTextHash?: string;
  /** D-003: el cliente no autorizó y se le ofreció un asesor (siguiente respuesta: sí/no). */
  authorizationDeclined?: boolean;
  /** D-003: se le enviaron los canales de soporte y el chat sigue abierto en el menú. */
  supportRedirected?: boolean;
  /**
   * Eligió C o D: se le preguntó qué necesita. Si su respuesta no es una compra, va la plantilla
   * de «chat exclusivo de ventas»; si lo es, sigue la venta del proceso que corresponda.
   */
  needAsked?: boolean;
  /**
   * D-013: ya autorizó y se le pidieron los datos (plantilla SOLICITUD_DATOS). 13/10/2026: la
   * venta pasa al backoffice cuando están los datos que pide el flujo.
   */
  dataRequested?: boolean;
  /** 13/10/2026: datos del cliente tras el «SÍ» (cifrados con el perfil; nunca en logs). */
  saleDocument?: string;
  saleFullName?: string;
  saleEmail?: string;
  salePhone?: string;
  /** Mensajes seguidos sin datos nuevos después de pedirlos (texto: «1», «2»…). */
  dataReminders?: string;
  /** v1.9: versión del catálogo (Brain) y hash del registro del plan aceptado (trazabilidad). */
  planCatalogVersionId?: string;
  planRecordHash?: string;
  /** D-011: ya se le enviaron las imágenes de los planes de su proceso (una vez por conversación). */
  planImagesSent?: boolean;
  /** D-011: no aceptó el primero y ya recibió las imágenes de los demás planes. */
  planImagesRestSent?: boolean;
  /** D-014: ya recibió la circular de apps de video. */
  videoImagesSent?: boolean;
  /**
   * Imágenes de la circular de apps de video que ya recibió (ids separados por coma): una por
   * plataforma que pida, sin repetir.
   */
  videoImagesSentIds?: string;
}

export interface ChatTurnMessage {
  role: 'customer' | 'bot';
  text: string;
}

export interface ConversationState {
  conversationId: string;
  stage: Stage;
  profile: Profile;
  /** Últimos mensajes (los más recientes al final), ya descifrados. */
  history: ChatTurnMessage[];
  /** D-004: versión del agente con la que empezó la conversación (la conserva hasta el final). */
  agentVersionId?: string;
}

/** Lo que debe pasar fuera del motor después del turno. */
export type TurnAction =
  | { type: 'SEND'; text: string }
  /** D-011: imagen de planes del catálogo publicado (caption solo en la primera). */
  | { type: 'SEND_IMAGE'; image: PlanImageRef; caption: string | null }
  /** 13/10/2026: con los datos del cliente tras el «SÍ» para el resumen de la venta. */
  | { type: 'TRANSFER_BACKOFFICE'; saleDataNote?: string }
  | { type: 'CLOSE'; reason: 'SUPPORT' | 'NO_SALE' }
  | { type: 'ESCALATE' }
  | { type: 'NEEDS_REVIEW'; reason: string }
  /** D-009: el proveedor de LLM no responde → pausar todos los robots; nada se procesa. */
  | { type: 'LLM_OUTAGE'; reason: string }
  /** D-018: amenaza de violencia del cliente → alerta a supervisores; la conversación sigue. */
  | { type: 'ALERT'; code: 'CUSTOMER_THREAT' }
  | {
      type: 'RECORD_CONSENT';
      textShownHash: string;
      templateVersion: string;
      customerReply: string;
    };

export type ValidationResult = 'OK' | 'REGENERATED' | 'FALLBACK';

export interface LlmCallRecord {
  stage: Stage;
  provider: string;
  model: string;
  promptVersionId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  validationResult: ValidationResult;
}

export interface TurnResult {
  stage: Stage;
  profile: Profile;
  actions: TurnAction[];
  llmCalls: LlmCallRecord[];
  validationResult: ValidationResult | 'NO_LLM' | 'PROVIDER_ERROR';
  /** v1.9: qué Brains, versiones y registros usó el turno (D-001 D7). */
  knowledge?: KnowledgeUsageRecord[];
  /** v1.9: el catálogo publicado no tiene planes para este proceso (se escaló). */
  catalogEmpty?: SaleProcess;
}
