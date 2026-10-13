/**
 * D-010: notas de voz del cliente. El robot descarga el audio de Abaya y lo sube al servidor;
 * el worker lo transcribe y el motor recibe el texto, como si el cliente lo hubiera escrito.
 */

/** Tope del archivo que acepta la pasarela (una nota de 2 min en Opus pesa unos 300 KB). */
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** Formatos de audio aceptados (WhatsApp usa Ogg/Opus). */
export const AUDIO_MIME_TYPES = [
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/webm',
  'audio/amr',
] as const;

/** Nombres alternativos que usan navegadores y sistemas operativos. */
const AUDIO_MIME_ALIASES: Record<string, string> = {
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
};

/** `audio/ogg; codecs=opus` → `audio/ogg`; null si no es un audio aceptado. */
export function normalizeAudioMime(raw: string | null | undefined): string | null {
  const lower = (raw ?? '').split(';')[0]!.trim().toLowerCase();
  const base = AUDIO_MIME_ALIASES[lower] ?? lower;
  return (AUDIO_MIME_TYPES as readonly string[]).includes(base) ? base : null;
}

export const TRANSCRIPT_STATUSES = [
  'PENDING',
  'OK',
  'UNINTELLIGIBLE',
  'TOO_LONG',
  'FAILED',
] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export interface SpeechRequest {
  audio: Buffer;
  mimeType: string;
  timeoutMs?: number;
}

export interface SpeechResult {
  /** Transcripción literal (vacía si no se entendió). */
  transcript: string;
  /** false: ruido, silencio o habla que no se entiende. */
  intelligible: boolean;
  model: string;
  latencyMs: number;
  /** Tokens que informó el proveedor (consumo). */
  inputTokens?: number;
  outputTokens?: number;
}

/** Voz a texto. Falla con `LlmProviderError` (mismo trato que el modelo, D-009). */
export interface SpeechToTextPort {
  readonly provider: string;
  transcribe(req: SpeechRequest): Promise<SpeechResult>;
}

/** AAD del audio cifrado mientras espera la transcripción. */
export const audioAad = (fingerprint: string) => `audio:${fingerprint}`;
