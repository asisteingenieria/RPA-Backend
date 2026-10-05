import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { createLogger } from '@abaya/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { PrismaRecoveryRepository, RecoveryService } from './recovery.service.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

async function conv(
  abayaChatId: string,
  robotUser = 'robot-a',
  status: 'ACTIVE' | 'CLOSED_SUPPORT' = 'ACTIVE',
) {
  return db.prisma.conversation.create({ data: { abayaChatId, robotUser, status } });
}

async function outbound(
  conversationId: string,
  status: 'PENDING' | 'SENDING' | 'SENT_VERIFIED' | 'UNCERTAIN',
) {
  return db.prisma.message.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      idempotencyKey: `${conversationId}-${status}-${Math.random()}`,
      bodyEncrypted: new Uint8Array([1]),
      status,
      occurredAt: new Date(),
    },
  });
}

function service(inbox: string[]) {
  const enqueued: string[] = [];
  const alerts = new MemoryAlertAdapter();
  const svc = new RecoveryService({
    robotUser: 'robot-a',
    repo: new PrismaRecoveryRepository(db.prisma),
    inboxChatIds: async () => inbox,
    enqueueOutbound: async (id) => void enqueued.push(id),
    alerts,
    logger: createLogger('t', { level: 'silent' }),
  });
  return { svc, enqueued, alerts };
}

describe('RecoveryService (PostgreSQL)', () => {
  it('reencola solo PENDING/SENDING del propio robot, en orden', async () => {
    const a = await conv('CH-1');
    const b = await conv('CH-2', 'robot-b');
    const p1 = await outbound(a.id, 'PENDING');
    const p2 = await outbound(a.id, 'SENDING');
    await outbound(a.id, 'SENT_VERIFIED');
    await outbound(a.id, 'UNCERTAIN'); // nunca se reintenta
    await outbound(b.id, 'PENDING'); // es de otro robot
    const t = service(['CH-1']);
    expect(await t.svc.run()).toEqual({ requeued: 2, missing: 0 });
    expect(t.enqueued).toEqual([p1.id, p2.id]);
  });

  it('conversación abierta que ya no está en la bandeja → NEEDS_REVIEW y alerta', async () => {
    await conv('CH-1');
    const gone = await conv('CH-2');
    await conv('CH-3', 'robot-a', 'CLOSED_SUPPORT');
    const t = service(['CH-1']);
    expect(await t.svc.run()).toEqual({ requeued: 0, missing: 1 });
    expect(
      (await db.prisma.conversation.findUniqueOrThrow({ where: { id: gone.id } })).status,
    ).toBe('NEEDS_REVIEW');
    expect(t.alerts.raised[0]).toMatchObject({
      code: 'CHATS_MISSING_FROM_INBOX',
      severity: 'ALTA',
    });
  });

  it('bandeja vacía (probablemente no cargó): no marca nada', async () => {
    await conv('CH-1');
    const t = service([]);
    expect(await t.svc.run()).toEqual({ requeued: 0, missing: 0 });
  });
});
