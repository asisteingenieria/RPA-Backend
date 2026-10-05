export type SenderType = 'CUSTOMER' | 'AGENT' | 'SYSTEM';

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
}
