export type SenderType = 'CUSTOMER' | 'AGENT' | 'SYSTEM';

/**
 * D-010 / D-047: adjunto del cliente tal como lo anuncia Abaya (el archivo se descarga aparte):
 * nota de voz (`AUDIO`) o imagen/sticker (`IMAGE`).
 */
export interface InboundMedia {
  kind: 'AUDIO' | 'IMAGE';
  /** Dónde está el archivo en Abaya (URL relativa o absoluta, `blob:` o `data:`). */
  url: string;
  mimeType?: string;
  durationSec?: number;
}

/** @deprecated nombre anterior a D-047. */
export type InboundAudio = InboundMedia;

/** Mensaje tal como se leyó de Abaya (por red o por DOM), ya normalizado. */
export interface InboundMessage {
  abayaChatId: string;
  /** Id de Abaya si lo expone; si no, la huella se calcula con el contenido y la posición. */
  messageId?: string;
  sender: SenderType;
  text: string;
  occurredAt: Date;
  /** Posición en la conversación (respaldo para la huella cuando no hay id). */
  position?: number;
  /** D-010: nota de voz (texto vacío); D-047: imagen (el texto es su pie de foto, si trae). */
  media?: InboundMedia;
}
