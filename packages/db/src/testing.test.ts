import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from './testing.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.stop();
});

describe('base de datos de pruebas', () => {
  it('aplica la migración inicial y la restricción única de huella deduplica', async () => {
    const c = await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-1', robotUser: 'r' },
    });
    const msg = {
      conversationId: c.id,
      direction: 'INBOUND' as const,
      fingerprint: 'f1',
      bodyEncrypted: new Uint8Array([1]),
      occurredAt: new Date(),
    };
    await db.prisma.message.create({ data: msg });
    await expect(db.prisma.message.create({ data: msg })).rejects.toMatchObject({ code: 'P2002' });
    await db.reset();
    expect(await db.prisma.conversation.count()).toBe(0);
  });
});
