import { HttpException, HttpStatus } from '@nestjs/common';

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'end' | 'error', cb: (err?: Error) => void): void;
}

/**
 * Cuerpo binario (`application/octet-stream` o `audio/*`): el parser JSON de Nest no lo toca y
 * se lee aquí con un tope, sin subir el límite global de JSON.
 */
export function readBody(req: RawRequest, limit: number, tooLarge: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpException(tooLarge, HttpStatus.PAYLOAD_TOO_LARGE));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e ?? new Error('error de lectura')));
  });
}
