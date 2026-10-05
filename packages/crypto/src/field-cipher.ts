import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 1;

/**
 * Cifrado de campos con AES-256-GCM.
 * Formato: [versión 1 byte][iv 12][tag 16][texto cifrado].
 * `aad` liga el cifrado a su contexto (p. ej. id del registro) para evitar que se copie a otro.
 */
export class FieldCipher {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('La clave debe tener 32 bytes');
    this.key = key;
  }

  encrypt(plain: string | Buffer, aad?: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), data]);
  }

  decrypt(payload: Uint8Array, aad?: string): Buffer {
    const buf = Buffer.from(payload);
    if (buf[0] !== VERSION) throw new Error('Versión de cifrado no soportada');
    const iv = buf.subarray(1, 1 + IV_LEN);
    const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const data = buf.subarray(1 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  decryptString(payload: Uint8Array, aad?: string): string {
    return this.decrypt(payload, aad).toString('utf8');
  }
}
