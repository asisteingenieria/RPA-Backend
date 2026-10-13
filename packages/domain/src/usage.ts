/**
 * Consumo de los modelos (tokens) para la vista «Consumo» del panel. Las respuestas del agente en
 * conversaciones reales ya quedan en `LlmCall` (con su conversación); aquí van los demás usos.
 * Solo cuenta tokens: nunca guarda contenido.
 */

/** Usos de los modelos, además de las conversaciones (`CHAT`, que vive en `LlmCall`). */
export const USAGE_KINDS = ['VOICE', 'IMAGE_READ', 'EMBEDDING', 'EVAL', 'TEST'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export interface ModelUsage {
  kind: UsageKind;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number | null;
  /** true: tokens calculados aproximadamente (el proveedor no los informa, p. ej. embeddings). */
  estimated?: boolean;
}

/** Registra consumo sin frenar ni romper el trabajo (si falla, solo se pierde la cifra). */
export interface UsageRecorder {
  record(u: ModelUsage): void;
}

export const NO_USAGE: UsageRecorder = { record: () => undefined };
