import { MemoryAlertAdapter } from '@abaya/alerts';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { createLogger } from '@abaya/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AlertMonitor,
  closeInactive,
  conversationsWithPendingInbound,
  databaseChecks,
} from './maintenance.js';

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

const silent = createLogger('t', { level: 'silent' });
const HOUR = 3_600_000;

async function conv(
  abayaChatId: string,
  lastInboundAt: Date | null,
  status: 'ACTIVE' | 'TRANSFERRING' = 'ACTIVE',
) {
  return db.prisma.conversation.create({
    data: { abayaChatId, robotUser: 'robot', status, lastInboundAt },
  });
}

async function inbound(conversationId: string, processed: boolean, createdAt = new Date()) {
  return db.prisma.message.create({
    data: {
      conversationId,
      direction: 'INBOUND',
      fingerprint: `${conversationId}-${Math.random()}`,
      bodyEncrypted: new Uint8Array([1]),
      occurredAt: createdAt,
      createdAt,
      processedAt: processed ? new Date() : null,
    },
  });
}

describe('recuperación al reiniciar', () => {
  it('encuentra las conversaciones abiertas con mensajes sin atender', async () => {
    const a = await conv('CH-1', new Date());
    const b = await conv('CH-2', new Date());
    const c = await conv('CH-3', new Date(), 'TRANSFERRING');
    await inbound(a.id, false);
    await inbound(b.id, true);
    await inbound(c.id, false);
    expect(await conversationsWithPendingInbound(db.prisma)).toEqual([a.id]);
  });
});

describe('cierre por inactividad', () => {
  it('cierra solo las inactivas sin pendientes y emite el evento para el robot', async () => {
    const now = new Date();
    const old = await conv('CH-1', new Date(now.getTime() - 3 * HOUR));
    const recent = await conv('CH-2', new Date(now.getTime() - 10 * 60_000));
    const oldButPending = await conv('CH-3', new Date(now.getTime() - 3 * HOUR));
    await inbound(oldButPending.id, false);
    expect(await closeInactive(db.prisma, now, 120)).toBe(1);
    const statuses = await db.prisma.conversation.findMany({ select: { id: true, status: true } });
    const s = new Map(statuses.map((x) => [x.id, x.status]));
    expect([s.get(old.id), s.get(recent.id), s.get(oldButPending.id)]).toEqual([
      'CLOSED_INACTIVE',
      'ACTIVE',
      'ACTIVE',
    ]);
    const ev = await db.prisma.outboxEvent.findFirstOrThrow();
    expect(ev.payload).toMatchObject({
      reason: 'INACTIVE',
      abayaChatId: 'CH-1',
      robotUser: 'robot',
    });
    // Idempotente.
    expect(await closeInactive(db.prisma, now, 120)).toBe(0);
  });
});

describe('AlertMonitor con chequeos de BD', () => {
  it('alerta al activarse, no repite enseguida y registra la resolución', async () => {
    const alerts = new MemoryAlertAdapter();
    const monitor = new AlertMonitor(databaseChecks(db.prisma), alerts, silent);
    const now = new Date();

    expect(await monitor.tick(now)).toEqual([]);

    await db.prisma.rpaSession.create({
      data: { robotUser: 'robot', status: 'DOWN', lastHeartbeat: now, consecutiveFails: 3 },
    });
    const c = await conv('CH-9', now);
    await db.prisma.sale.create({
      data: {
        conversationId: c.id,
        process: 'LINEA_NUEVA',
        planCode: 'L1',
        summaryEncrypted: new Uint8Array([1]),
        createdAt: new Date(now.getTime() - 10 * 60_000),
      },
    });
    await inbound(c.id, false, new Date(now.getTime() - 5 * 60_000));

    const raised = await monitor.tick(now);
    expect(raised.sort()).toEqual(['CUSTOMER_UNANSWERED', 'SALE_NOT_TRANSFERRED', 'SESSION_DOWN']);
    expect(alerts.raised.find((a) => a.code === 'SALE_NOT_TRANSFERRED')).toMatchObject({
      severity: 'CRITICA',
      detail: { conversationIds: [c.id] },
    });

    // Un minuto después sigue activa: no se repite.
    expect(await monitor.tick(new Date(now.getTime() + 60_000))).toEqual([]);
    // Media hora después se repite.
    expect(await monitor.tick(new Date(now.getTime() + 31 * 60_000))).toHaveLength(3);

    // Se resuelve la sesión: deja de alertar.
    await db.prisma.rpaSession.update({
      where: { robotUser: 'robot' },
      data: { status: 'ACTIVE', lastHeartbeat: new Date(now.getTime() + 40 * 60_000) },
    });
    const after = await monitor.tick(new Date(now.getTime() + 40 * 60_000));
    expect(after).not.toContain('SESSION_DOWN');
  });

  it('heartbeat perdido: alerta si el robot cayó, no si se apagó en orden', async () => {
    const monitor = new AlertMonitor(databaseChecks(db.prisma), new MemoryAlertAdapter(), silent);
    const old = new Date(Date.now() - 5 * 60_000);
    for (const robotUser of ['robot-caido', 'robot-apagado']) {
      await db.prisma.rpaSession.create({
        data: { robotUser, status: 'ACTIVE', lastHeartbeat: old, consecutiveFails: 0 },
      });
    }
    await db.prisma.robot.create({ data: { robotUser: 'robot-caido', state: 'ONLINE' } });
    await db.prisma.robot.create({ data: { robotUser: 'robot-apagado', state: 'STOPPED' } });
    const alerts = new MemoryAlertAdapter();
    const m = new AlertMonitor(databaseChecks(db.prisma), alerts, silent);
    expect(await m.tick()).toContain('HEARTBEAT_LOST');
    expect(alerts.raised.find((a) => a.code === 'HEARTBEAT_LOST')?.detail).toEqual({
      robots: ['robot-caido'],
    });
    await db.prisma.robot.update({
      where: { robotUser: 'robot-caido' },
      data: { state: 'STOPPED' },
    });
    expect(await monitor.tick()).not.toContain('HEARTBEAT_LOST');
  });

  it('robot sobrecargado: más chats abiertos que el tope (por robot)', async () => {
    const alerts = new MemoryAlertAdapter();
    const monitor = new AlertMonitor(
      databaseChecks(db.prisma, { maxChatsPerRobot: 3, responseP95AlertMs: 20_000 }),
      alerts,
      silent,
    );
    const mk = (robotUser: string, n: number, status = 'ACTIVE' as const) =>
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          db.prisma.conversation.create({
            data: { abayaChatId: `${robotUser}-${status}-${i}`, robotUser, status },
          }),
        ),
      );
    await mk('robot-ok', 3);
    await mk('robot-lleno', 3);
    await mk('robot-ok', 5, 'CLOSED_NO_SALE' as never); // cerrados no cuentan
    expect(await monitor.tick()).not.toContain('ROBOT_OVERLOADED');
    await db.prisma.conversation.create({
      data: { abayaChatId: 'extra', robotUser: 'robot-lleno', status: 'TRANSFERRING' },
    });
    expect(await monitor.tick()).toContain('ROBOT_OVERLOADED');
    expect(alerts.raised.find((a) => a.code === 'ROBOT_OVERLOADED')?.detail).toEqual({
      max: 3,
      robots: [{ robotUser: 'robot-lleno', chats: 4 }],
    });
  });

  it('respuesta lenta: p95 de los últimos 15 min por encima del umbral, con muestras suficientes', async () => {
    const alerts = new MemoryAlertAdapter();
    const monitor = new AlertMonitor(
      databaseChecks(db.prisma, { maxChatsPerRobot: 3, responseP95AlertMs: 20_000 }),
      alerts,
      silent,
    );
    const now = Date.now();
    let n = 0;
    const reply = async (robotUser: string, ms: number) => {
      const c = await db.prisma.conversation.create({
        data: { abayaChatId: `rt-${n}`, robotUser, status: 'ACTIVE' },
      });
      await db.prisma.message.create({
        data: {
          conversationId: c.id,
          direction: 'OUTBOUND',
          idempotencyKey: `k-${n++}`,
          bodyEncrypted: new Uint8Array([1]),
          status: 'SENT_VERIFIED',
          occurredAt: new Date(now - 60_000),
          respondsToAt: new Date(now - 60_000 - ms),
          sentAt: new Date(now - 60_000),
        },
      });
    };
    for (let i = 0; i < 4; i++) await reply('robot-lento', 30_000);
    expect(await monitor.tick()).not.toContain('RESPONSE_SLOW'); // 4 muestras: no alcanza
    await reply('robot-lento', 30_000);
    for (let i = 0; i < 6; i++) await reply('robot-rapido', 6_000);
    expect(await monitor.tick()).toContain('RESPONSE_SLOW');
    expect(alerts.raised.find((a) => a.code === 'RESPONSE_SLOW')?.detail).toEqual({
      thresholdMs: 20_000,
      robots: [{ robotUser: 'robot-lento', p95Ms: 30_000, samples: 5 }],
    });
  });

  it('selector roto: tres acciones seguidas fallidas de un robot', async () => {
    const alerts = new MemoryAlertAdapter();
    const monitor = new AlertMonitor(databaseChecks(db.prisma), alerts, silent);
    await db.prisma.rpaSession.create({
      data: {
        robotUser: 'robot',
        status: 'ACTIVE',
        lastHeartbeat: new Date(),
        consecutiveFails: 0,
      },
    });
    for (const [i, result] of ['OK', 'ERROR', 'UNCERTAIN', 'ERROR'].entries()) {
      await db.prisma.rpaActionLog.create({
        data: {
          robotUser: 'robot',
          action: 'SEND',
          result,
          durationMs: 1,
          prevHash: `p${i}`,
          hash: `h${i}`,
        },
      });
    }
    expect(await monitor.tick()).toContain('SELECTOR_BROKEN');
  });
});
