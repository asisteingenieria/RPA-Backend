/** Nombres de colas BullMQ (sección 2.2). */
export const QUEUES = {
  inbound: 'abaya.inbound',
  outbound: 'abaya.outbound',
  transfer: 'abaya.transfer',
  close: 'abaya.close',
} as const;

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
