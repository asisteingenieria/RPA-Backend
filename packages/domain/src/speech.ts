/**
 * D-010: notas de voz del cliente. El robot descarga el audio de Abaya y lo sube al servidor;
 * el worker lo transcribe y el motor recibe el texto, como si el cliente lo hubiera escrito.
 */

/**
 * Texto con el que llega una nota de voz que el robot no descargó (hoy, en ySocial real, todas:
 * la captura está pendiente). El worker la trata como nota de voz que no se pudo oír: responde
 * la plantilla NOTA_DE_VOZ_ILEGIBLE (pedir que escriba), sin llamar al modelo (15/10/2026).
 */
export const AUDIO_PLACEHOLDER = '[audio]';

/**
 * D-047: texto con el que llega una imagen (o sticker) que el robot no descargó o que no se pudo
 * describir: el worker responde la plantilla IMAGEN_ILEGIBLE (pedir que cuente en texto).
 */
export const IMAGE_PLACEHOLDER = '[imagen]';

/** Tope del archivo que acepta la pasarela (una nota de 2 min en Opus pesa unos 300 KB). */
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** D-047: tope de una imagen del cliente (WhatsApp las comprime: casi siempre < 500 KB). */
export const MAX_INBOUND_IMAGE_BYTES = 5 * 1024 * 1024;

/** D-047: formatos de imagen aceptados (los stickers de WhatsApp son WebP). */
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** `image/jpg` → `image/jpeg`; null si no es una imagen aceptada (GIF animado, SVG…). */
export function normalizeImageMime(raw: string | null | undefined): string | null {
  const lower = (raw ?? '').split(';')[0]!.trim().toLowerCase();
  const base = lower === 'image/jpg' || lower === 'image/pjpeg' ? 'image/jpeg' : lower;
  return (IMAGE_MIME_TYPES as readonly string[]).includes(base) ? base : null;
}

/** D-047: tipo de adjunto entrante. */
export type InboundMediaKind = 'AUDIO' | 'IMAGE';

/** Normaliza el formato según el tipo de adjunto (null = no aceptado). */
export function normalizeMediaMime(
  kind: InboundMediaKind,
  raw: string | null | undefined,
): string | null {
  return kind === 'IMAGE' ? normalizeImageMime(raw) : normalizeAudioMime(raw);
}

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

/**
 * D-047: describe una imagen que mandó el cliente (foto, captura, sticker) para que el motor la
 * lea como texto. Falla con `LlmProviderError`, igual que la voz a texto.
 */
export interface ImageDescriberPort {
  readonly provider: string;
  describe(req: ImageDescribeRequest): Promise<ImageDescribeResult>;
}

export interface ImageDescribeRequest {
  image: Buffer;
  mimeType: string;
  timeoutMs?: number;
}

export interface ImageDescribeResult {
  /** Descripción breve en español, sin datos personales (vacía si no se pudo ver). */
  description: string;
  /** false: imagen en blanco, corrupta o que no se distingue. */
  readable: boolean;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * AAD del adjunto cifrado mientras espera la transcripción (audio) o la descripción (imagen,
 * D-047: mismo AAD; el tipo va en `Message.mediaKind`).
 */
export const audioAad = (fingerprint: string) => `audio:${fingerprint}`;
