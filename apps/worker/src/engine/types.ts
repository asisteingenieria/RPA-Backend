import type { Stage } from '@abaya/domain';
import type { KnowledgeUsageRecord } from '@abaya/knowledge';

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

export type MenuOption = 'A' | 'B' | 'C' | 'D';

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
  /** v1.9: versión del catálogo (Brain) y hash del registro del plan aceptado (trazabilidad). */
  planCatalogVersionId?: string;
  planRecordHash?: string;
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
}

/** Lo que debe pasar fuera del motor después del turno. */
export type TurnAction =
  | { type: 'SEND'; text: string }
  | { type: 'TRANSFER_BACKOFFICE' }
  | { type: 'CLOSE'; reason: 'SUPPORT' | 'NO_SALE' }
  | { type: 'ESCALATE' }
  | { type: 'NEEDS_REVIEW'; reason: string }
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
