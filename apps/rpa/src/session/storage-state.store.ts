import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FieldCipher } from '@abaya/crypto';
import type { BrowserContext } from 'playwright';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface StorageStateStore {
  load(): Promise<StorageState | undefined>;
  save(state: StorageState): Promise<void>;
  clear(): Promise<void>;
}

/**
 * storageState de Playwright cifrado con AES-256-GCM (sección 8). El AAD liga el archivo al
 * usuario robot: un archivo copiado de otro usuario no se puede abrir.
 */
export class EncryptedFileStorageStateStore implements StorageStateStore {
  private readonly file: string;
  private readonly aad: string;

  constructor(
    private readonly dir: string,
    robotUser: string,
    private readonly cipher: FieldCipher,
  ) {
    const safe = robotUser.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.file = join(dir, `storage-state.${safe}.enc`);
    this.aad = `storage-state:${robotUser}`;
  }

  get path(): string {
    return this.file;
  }

  async load(): Promise<StorageState | undefined> {
    let raw: Buffer;
    try {
      raw = await readFile(this.file);
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(this.cipher.decryptString(raw, this.aad)) as StorageState;
    } catch {
      // Corrupto, alterado o cifrado con otra clave: se descarta y se hace login.
      await this.clear();
      return undefined;
    }
  }

  async save(state: StorageState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file, this.cipher.encrypt(JSON.stringify(state), this.aad), {
      mode: 0o600,
    });
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

export class MemoryStorageStateStore implements StorageStateStore {
  state: StorageState | undefined;
  async load() {
    return this.state;
  }
  async save(state: StorageState) {
    this.state = state;
  }
  async clear() {
    this.state = undefined;
  }
}
