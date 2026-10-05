/** AAD del cifrado del cuerpo de un mensaje: liga el texto cifrado a su registro. */
export function inboundAad(fingerprint: string): string {
  return `msg:${fingerprint}`;
}

export function outboundAad(idempotencyKey: string): string {
  return `out:${idempotencyKey}`;
}

export type RpaAction = 'LOGIN' | 'OPEN_CHAT' | 'SEND' | 'NOTE' | 'TRANSFER' | 'CLOSE';
export type RpaActionResult = 'OK' | 'ERROR' | 'UNCERTAIN' | 'BLOCKED' | 'SKIPPED';
