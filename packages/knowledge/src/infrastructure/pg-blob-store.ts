import { randomUUID } from 'node:crypto';
import type { FieldCipher } from '@abaya/crypto';
import type { PrismaClient } from '@abaya/db';
import { knowledgeBlobAad as aad } from '@abaya/domain';
import type { BlobStore } from '../domain/ports.js';

/**
 * Archivos de las fuentes cifrados en PostgreSQL (D-001 D10). No hay S3 en el proyecto: cuando
 * exista un bucket se agrega otro adaptador de `BlobStore` sin tocar el resto.
 */
export class PgBlobStore implements BlobStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async put(bytes: Uint8Array): Promise<string> {
    const id = randomUUID();
    await this.prisma.knowledgeBlob.create({
      data: {
        id,
        dataEncrypted: new Uint8Array(this.cipher.encrypt(Buffer.from(bytes), aad(id))),
      },
    });
    return id;
  }

  async get(ref: string): Promise<Uint8Array> {
    const row = await this.prisma.knowledgeBlob.findUnique({ where: { id: ref } });
    if (!row) throw new Error('archivo de la fuente no encontrado');
    return new Uint8Array(this.cipher.decrypt(row.dataEncrypted, aad(ref)));
  }

  async delete(ref: string): Promise<void> {
    await this.prisma.knowledgeBlob.deleteMany({ where: { id: ref } });
  }
}
