import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
/** v1: [1][iv][tag][datos] (sin id de clave). v2: [2][idClave][iv][tag][datos]. */
const V1 = 1;
const V2 = 2;

export interface KeyRing {
  /** Clave con la que se cifra lo nuevo. */
  current: { id: number; keyBase64: string };
  /** Claves anteriores: solo para descifrar datos viejos durante una rotación. */
  previous?: { id: number; keyBase64: string }[];
}

function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('La clave debe tener 32 bytes');
  return key;
}

/**
 * Cifrado de campos con AES-256-GCM y rotación de claves (sección 8).
 * `aad` liga el cifrado a su contexto (p. ej. id del registro) para evitar que se copie a otro.
 */
export class FieldCipher {
  private readonly currentId: number;
  private readonly keys = new Map<number, Buffer>();

  /** Acepta una sola clave en base64 (id 1) o un llavero. */
  constructor(keys: string | KeyRing) {
    const ring: KeyRing = typeof keys === 'string' ? { current: { id: 1, keyBase64: keys } } : keys;
    for (const k of [ring.current, ...(ring.previous ?? [])]) {
      if (!Number.isInteger(k.id) || k.id < 1 || k.id > 255)
        throw new Error('id de clave inválido (1–255)');
      if (this.keys.has(k.id)) throw new Error(`id de clave repetido: ${k.id}`);
      this.keys.set(k.id, parseKey(k.keyBase64));
    }
    this.currentId = ring.current.id;
  }

  /** Llavero desde texto `id:base64,id:base64` (FIELD_ENCRYPTION_PREVIOUS_KEYS). */
  static parsePrevious(spec: string | undefined): { id: number; keyBase64: string }[] {
    if (!spec?.trim()) return [];
    return spec.split(',').map((part) => {
      const i = part.indexOf(':');
      if (i < 1) throw new Error('formato de clave anterior: id:base64');
      return { id: Number(part.slice(0, i).trim()), keyBase64: part.slice(i + 1).trim() };
    });
  }

  encrypt(plain: string | Buffer, aad?: string): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.keys.get(this.currentId)!, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([V2, this.currentId]), iv, cipher.getAuthTag(), data]);
  }

  decrypt(payload: Uint8Array, aad?: string): Buffer {
    const buf = Buffer.from(payload);
    if (buf[0] === V2) {
      const key = this.keys.get(buf[1]!);
      if (!key) throw new Error(`clave ${buf[1]} no disponible`);
      return this.open(key, buf.subarray(2), aad);
    }
    if (buf[0] === V1) {
      // Formato anterior sin id de clave: probar las claves del llavero.
      for (const key of this.keys.values()) {
        try {
          return this.open(key, buf.subarray(1), aad);
        } catch {
          // siguiente clave
        }
      }
      throw new Error('ninguna clave descifra el dato');
    }
    throw new Error('Versión de cifrado no soportada');
  }

  decryptString(payload: Uint8Array, aad?: string): string {
    return this.decrypt(payload, aad).toString('utf8');
  }

  /** ¿El dato está cifrado con una clave distinta de la actual? (para re-cifrar al rotar). */
  needsReencryption(payload: Uint8Array): boolean {
    const buf = Buffer.from(payload);
    return !(buf[0] === V2 && buf[1] === this.currentId);
  }

  private open(key: Buffer, rest: Buffer, aad?: string): Buffer {
    const iv = rest.subarray(0, IV_LEN);
    const tag = rest.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = rest.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }
}

/** FieldCipher desde la configuración validada (clave actual + anteriores para rotar). */
export function cipherFromConfig(cfg: {
  FIELD_ENCRYPTION_KEY: string;
  FIELD_ENCRYPTION_KEY_ID: number;
  FIELD_ENCRYPTION_PREVIOUS_KEYS?: string;
}): FieldCipher {
  return new FieldCipher({
    current: { id: cfg.FIELD_ENCRYPTION_KEY_ID, keyBase64: cfg.FIELD_ENCRYPTION_KEY },
    previous: FieldCipher.parsePrevious(cfg.FIELD_ENCRYPTION_PREVIOUS_KEYS),
  });
}
