import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { createLogger } from '@abaya/logger';
import { PrismaInboundRepository } from '@abaya/robot-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaRecoveryRepository, RecoveryService } from './recovery.service.js';
import { TrayReconciler } from './tray-reconciler.js';

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

const logger = createLogger('t', { level: 'silent' });

async function conv(
  abayaChatId: string,
  robotUser = 'robot-a',
  status: 'ACTIVE' | 'WAITING_CONSENT' | 'CLOSED_SUPPORT' | 'NEEDS_REVIEW' = 'ACTIVE',
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

const statusOf = async (id: string) =>
  (await db.prisma.conversation.findUniqueOrThrow({ where: { id } })).status;
const msgStatus = async (id: string) =>
  (await db.prisma.message.findUniqueOrThrow({ where: { id } })).status;

describe('RecoveryService (PostgreSQL)', () => {
  it('reencola solo PENDING/SENDING del propio robot, en orden', async () => {
    const a = await conv('CH-1');
    const b = await conv('CH-2', 'robot-b');
    const p1 = await outbound(a.id, 'PENDING');
    const p2 = await outbound(a.id, 'SENDING');
    await outbound(a.id, 'SENT_VERIFIED');
    await outbound(a.id, 'UNCERTAIN'); // nunca se reintenta
    await outbound(b.id, 'PENDING'); // es de otro robot
    const enqueued: string[] = [];
    const svc = new RecoveryService({
      robotUser: 'robot-a',
      repo: new PrismaRecoveryRepository(db.prisma),
      enqueueOutbound: async (id) => void enqueued.push(id),
      logger,
    });
    expect(await svc.run()).toEqual({ requeued: 2 });
    expect(enqueued).toEqual([p1.id, p2.id]);
  });

  it('D-037: al arrancar no marca nada para revisión aunque falten chats', async () => {
    const gone = await conv('CH-2');
    const svc = new RecoveryService({
      robotUser: 'robot-a',
      repo: new PrismaRecoveryRepository(db.prisma),
      enqueueOutbound: async () => undefined,
      logger,
    });
    await svc.run();
    expect(await statusOf(gone.id)).toBe('ACTIVE');
  });
});

describe('TrayReconciler (PostgreSQL, D-037)', () => {
  function reconciler(tray: () => string[] | null) {
    let now = 0;
    const r = new TrayReconciler({
      robotUser: 'robot-a',
      repo: new PrismaRecoveryRepository(db.prisma),
      readTray: async () => tray(),
      logger,
      graceMs: 60_000,
      now: () => now,
    });
    return { r, advance: (ms: number) => void (now += ms) };
  }

  it('cierra lo que falta 60 s de la bandeja; sus PENDING quedan FAILED; sin tocar lo demás', async () => {
    const kept = await conv('CH-1');
    const gone = await conv('CH-2', 'robot-a', 'WAITING_CONSENT');
    const other = await conv('CH-3', 'robot-b'); // de otro robot
    const review = await conv('CH-4', 'robot-a', 'NEEDS_REVIEW'); // revisión humana: no se toca
    const pending = await outbound(gone.id, 'PENDING');
    const sending = await outbound(gone.id, 'SENDING'); // pudo escribirse: regla 2
    const t = reconciler(() => ['CH-1']);

    expect(await t.r.run()).toEqual([]); // primera vez que falta: empieza a contar
    t.advance(59_000);
    expect(await t.r.run()).toEqual([]);
    t.advance(1_000);
    expect(await t.r.run()).toEqual([gone.id]);

    expect(await statusOf(gone.id)).toBe('CLOSED_EXTERNALLY');
    expect(await statusOf(kept.id)).toBe('ACTIVE');
    expect(await statusOf(other.id)).toBe('ACTIVE');
    expect(await statusOf(review.id)).toBe('NEEDS_REVIEW');
    expect(await msgStatus(pending.id)).toBe('FAILED');
    expect(await msgStatus(sending.id)).toBe('SENDING');
  });

  it('bandeja vacía pero fiable: también cierra (la pantalla manda)', async () => {
    const gone = await conv('CH-1');
    const t = reconciler(() => []);
    await t.r.run();
    t.advance(60_000);
    expect(await t.r.run()).toEqual([gone.id]);
  });

  it('lectura no fiable (null): no decide nada ni cuenta tiempo', async () => {
    const c = await conv('CH-1');
    let tray: string[] | null = null;
    const t = reconciler(() => tray);
    await t.r.run();
    t.advance(120_000);
    expect(await t.r.run()).toEqual([]);
    tray = [];
    expect(await t.r.run()).toEqual([]); // recién empieza a contar
    expect(await statusOf(c.id)).toBe('ACTIVE');
  });

  it('si vuelve a la bandeja antes de 60 s, se reinicia la cuenta', async () => {
    const c = await conv('CH-1');
    let tray: string[] = [];
    const t = reconciler(() => tray);
    await t.r.run();
    t.advance(50_000);
    tray = ['CH-1'];
    await t.r.run();
    tray = [];
    t.advance(50_000);
    expect(await t.r.run()).toEqual([]);
    expect(await statusOf(c.id)).toBe('ACTIVE');
  });

  it('el cliente vuelve a escribir en el caso: se reabre', async () => {
    const c = await conv('CH-1');
    const t = reconciler(() => []);
    await t.r.run();
    t.advance(60_000);
    await t.r.run();
    expect(await statusOf(c.id)).toBe('CLOSED_EXTERNALLY');

    await new PrismaInboundRepository(db.prisma).insertInbound(c.id, {
      fingerprint: 'fp-1',
      bodyEncrypted: Buffer.from([1]),
      detectedVia: 'network',
      occurredAt: new Date(),
    });
    expect(await statusOf(c.id)).toBe('ACTIVE');
  });
});
