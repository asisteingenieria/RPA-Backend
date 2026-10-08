import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldCipher } from '@abaya/crypto';
import { describe, expect, it } from 'vitest';
import { EncryptedFileStorageStateStore, type StorageState } from './storage-state.store.js';

const state: StorageState = {
  cookies: [
    {
      name: 'sid',
      value: 'token-de-sesion-secreto',
      domain: 'abaya.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [],
};

async function tmp() {
  return mkdtemp(join(tmpdir(), 'abaya-ss-'));
}

describe('EncryptedFileStorageStateStore', () => {
  const cipher = new FieldCipher(randomBytes(32).toString('base64'));

  it('guarda cifrado y recupera el mismo estado', async () => {
    const store = new EncryptedFileStorageStateStore(await tmp(), 'robot-ventas-01', cipher);
    await store.save(state);
    const raw = await readFile(store.path);
    expect(raw.toString('latin1')).not.toContain('token-de-sesion-secreto');
    expect(await store.load()).toEqual(state);
  });

  it('devuelve undefined si no existe', async () => {
    const store = new EncryptedFileStorageStateStore(await tmp(), 'robot', cipher);
    expect(await store.load()).toBeUndefined();
  });

  it('descarta un archivo alterado', async () => {
    const store = new EncryptedFileStorageStateStore(await tmp(), 'robot', cipher);
    await store.save(state);
    const raw = await readFile(store.path);
    raw[raw.length - 1]! ^= 0xff;
    await writeFile(store.path, raw);
    expect(await store.load()).toBeUndefined();
  });

  it('no abre el estado de otro usuario robot (AAD)', async () => {
    const dir = await tmp();
    const a = new EncryptedFileStorageStateStore(dir, 'robot-a', cipher);
    await a.save(state);
    const b = new EncryptedFileStorageStateStore(dir, 'robot-b', cipher);
    // Simula copiar el archivo de A como si fuera de B.
    await writeFile(b.path, await readFile(a.path));
    expect(await b.load()).toBeUndefined();
  });
});
