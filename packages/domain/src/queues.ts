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
}

export interface CloseJob {
  conversationId: string;
  abayaChatId: string;
  reason: 'SUPPORT' | 'NO_SALE' | 'INACTIVE';
}
