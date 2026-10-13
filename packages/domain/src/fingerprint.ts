import type { InboundMessage } from './inbound.js';

/**
 * Entrada canónica de la huella de un mensaje entrante (sección 5):
 * - con id de Abaya: abayaChatId + messageId
 * - sin id: abayaChatId + remitente + timestamp + texto + posición
 * El hash (sha256) lo aplica quien tenga crypto; el dominio no depende de librerías.
 */
export function fingerprintInput(m: InboundMessage): string {
  if (m.messageId) return ['id', m.abayaChatId, m.messageId].join('\u001f');
  return [
    'content',
    m.abayaChatId,
    m.sender,
    m.occurredAt.toISOString(),
    // D-010: una nota de voz no tiene texto propio (la red lo deja vacío y el DOM pinta la
    // duración): la identifica su archivo.
    m.media ? `audio:${m.media.url}` : m.text,
    String(m.position ?? ''),
  ].join('\u001f');
}
