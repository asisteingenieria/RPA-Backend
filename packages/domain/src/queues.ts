import type { AgentConfig } from './agent-config.js';
import type { Stage } from './index.js';

/** Nombres de colas BullMQ (sección 2.2). */
export const QUEUES = {
  inbound: 'abaya.inbound',
  outbound: 'abaya.outbound',
  transfer: 'abaya.transfer',
  close: 'abaya.close',
  /** Evaluación de una versión del agente (evidencia, D-005) o de un Brain (v1.8, regla 13). */
  evals: 'abaya.evals',
  /** "Probar agente" del panel: turno simulado con respuesta inmediata (v1.8). */
  agentTest: 'abaya.agent-test',
  /** Ingesta de fuentes de los Brains (v1.9, docs/DECISIONS.md D-001 D9). */
  knowledgeIngest: 'abaya.knowledge-ingest',
} as const;

export interface EvalJob {
  versionId: string;
  requestedBy: string;
  /** v1.9: `brain` = versión del catálogo de un Brain; sin valor = versión del agente. */
  kind?: 'agent' | 'brain';
}

/**
 * "Probar agente" del panel (v1.8): un turno del motor real contra una conversación simulada.
 * No toca Abaya ni guarda nada; el panel conserva el estado entre turnos.
 */
export interface AgentTestJob {
  agent: AgentConfig;
  state: {
    stage: Stage;
    /** Datos del perfil (texto) y marcas del flujo (sí/no, D-003). */
    profile: Record<string, string | boolean>;
    history: { role: 'customer' | 'bot'; text: string }[];
  };
  message: string;
}

export interface AgentTestResult {
  stage: Stage;
  profile: Record<string, string | boolean>;
  /** Mensajes que el robot enviaría, en orden. */
  replies: string[];
  /** Acciones que no son mensajes (transferir, cerrar, escalar, revisión, consentimiento). */
  events: string[];
  validation: string;
  llm: { provider: string; model: string; latencyMs: number; validationResult: string }[];
}

export interface InboundJob {
  conversationId: string;
  abayaChatId: string;
  messageId: string;
}

export interface OutboundJob {
  messageId: string;
  abayaChatId: string;
}

export interface TransferJob {
  conversationId: string;
  abayaChatId: string;
  /** BACKOFFICE: venta autorizada. HUMAN: caso que la IA no puede manejar (sección 6.6). */
  target: 'BACKOFFICE' | 'HUMAN';
  /** Mensajes que deben estar SENT_VERIFIED antes de transferir (p. ej. la despedida). */
  afterMessageIds: string[];
}

export interface CloseJob {
  conversationId: string;
  abayaChatId: string;
  reason: 'SUPPORT' | 'NO_SALE' | 'INACTIVE';
  afterMessageIds: string[];
}

/**
 * Las acciones sobre Abaya (envío, transferencia, cierre) van a una cola POR usuario robot:
 * cada chat solo existe en la bandeja de su robot (sección 2.4: más volumen = más robots).
 */
export function robotQueue(
  base: (typeof QUEUES)['outbound' | 'transfer' | 'close'],
  robotUser: string,
): string {
  return `${base}.${robotUser.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Bandera del apagado de emergencia en Redis (la activa el panel, la lee el rpa). */
export const KILL_SWITCH_KEY = 'abaya:killswitch';

/** Pausa de un solo robot (panel → ese rpa); se revisa junto con el kill switch global. */
export function robotPauseKey(robotUser: string): string {
  return `abaya:pause:${robotUser.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}
