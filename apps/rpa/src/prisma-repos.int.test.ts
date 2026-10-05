import { randomBytes } from 'node:crypto';
import { FieldCipher, verifyChain } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { saleAad } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaActionLog, actionLogHashInput } from './audit/action-log.js';
import { PrismaHandoffRepository } from './handoff/handoff.repository.js';
import { InboundProcessor } from './inbound/inbound-processor.js';
import { MemoryInboundQueue } from './inbound/inbound-queue.js';
import { PrismaInboundRepository } from './inbound/inbound.repository.js';
import { PrismaOutboundRepository } from './outbound/outbound.repository.js';
import { PrismaSessionRepository } from './session/session.repository.js';

// Integración de los repositorios del rpa contra PostgreSQL real (temporal).

const cipher = new FieldCipher(randomBytes(32).toString('base64'));
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

describe('PrismaInboundRepository', () => {
  it('mensaje detectado por red y DOM a la vez (procesadores distintos) se guarda una sola vez', async () => {
    const repo = new PrismaInboundRepository(db.prisma);
    const queue = new MemoryInboundQueue();
    const mk = () =>
      new InboundProcessor({
        robotUser: 'robot',
        repo,
        queue,
        cipher,
        logger: createLogger('t', { level: 'silent' }),
      });
    // Dos procesadores = sin caché compartida: la garantía es la restricción única.
    const a = mk();
    const b = mk();
    const m = {
      abayaChatId: 'CH-1',
      messageId: 'm-1',
      sender: 'CUSTOMER' as const,
      text: 'Hola',
      occurredAt: new Date(),
    };
    await Promise.all([a.handle(m, 'network'), b.handle(m, 'dom'), a.handle(m, 'network')]);
    expect(await db.prisma.message.count()).toBe(1);
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    const conv = await db.prisma.conversation.findFirstOrThrow();
    expect(conv.lastInboundAt).toEqual(m.occurredAt);
  });

  it('creación concurrente de la misma conversación no falla', async () => {
    const repo = new PrismaInboundRepository(db.prisma);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => repo.ensureConversation('CH-9', 'robot')),
    );
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
  });
});

describe('PrismaActionLog', () => {
  it('encadena hashes por usuario robot, también con escrituras concurrentes', async () => {
    const log = new PrismaActionLog(db.prisma);
    const entry = (i: number) => ({
      robotUser: 'robot',
      action: 'SEND' as const,
      abayaChatId: `CH-${i}`,
      result: 'OK' as const,
      durationMs: i,
      traceRef: null,
      createdAt: new Date(Date.now() + i),
    });
    // Secuencial y luego concurrente: los conflictos se reintentan dentro de append.
    for (let i = 0; i < 3; i++) await log.append(entry(i));
    await Promise.all([3, 4, 5].map((i) => log.append(entry(i))));
    const rows = await db.prisma.rpaActionLog.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows).toHaveLength(6);
    const chain = rows.map((r) => ({
      data: actionLogHashInput({ ...r, action: r.action as 'SEND', result: r.result as 'OK' }),
      prevHash: r.prevHash,
      hash: r.hash,
    }));
    // Las filas concurrentes pueden quedar en otro orden de createdAt; se valida por enlaces.
    const byPrev = new Map(chain.map((c) => [c.prevHash, c]));
    const ordered = [];
    let cur = byPrev.get('0'.repeat(64));
    while (cur) {
      ordered.push(cur);
      cur = byPrev.get(cur.hash);
    }
    expect(ordered).toHaveLength(6);
    expect(verifyChain(ordered)).toBe(-1);
  });
});

describe('PrismaOutboundRepository y PrismaHandoffRepository', () => {
  it('estados de envío, venta descifrada y transferencia', async () => {
    const conv = await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-5', robotUser: 'robot' },
    });
    const msg = await db.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'OUTBOUND',
        idempotencyKey: 'k1',
        bodyEncrypted: new Uint8Array([1]),
        status: 'PENDING',
        occurredAt: new Date(),
      },
    });
    const out = new PrismaOutboundRepository(db.prisma);
    expect(await out.get(msg.id)).toMatchObject({
      abayaChatId: 'CH-5',
      status: 'PENDING',
      attempts: 0,
    });
    await out.setStatus(msg.id, 'SENDING', true);
    await out.setStatus(msg.id, 'SENT_VERIFIED');
    expect(await out.get(msg.id)).toMatchObject({ status: 'SENT_VERIFIED', attempts: 1 });
    expect(
      (await db.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).lastOutboundAt,
    ).not.toBeNull();

    await db.prisma.sale.create({
      data: {
        conversationId: conv.id,
        process: 'LINEA_NUEVA',
        planCode: 'L1',
        summaryEncrypted: new Uint8Array(cipher.encrypt('Resumen de venta', saleAad(conv.id))),
      },
    });
    const h = new PrismaHandoffRepository(db.prisma, cipher);
    expect(await h.outboundStatuses([msg.id])).toEqual(['SENT_VERIFIED']);
    expect(await h.sale(conv.id)).toEqual({ summary: 'Resumen de venta', noteOk: false });
    await h.markNoteOk(conv.id);
    await h.markTransferred(conv.id, 'BACKOFFICE');
    const sale = await db.prisma.sale.findUniqueOrThrow({ where: { conversationId: conv.id } });
    expect(sale.backofficeNoteOk).toBe(true);
    expect(sale.transferredAt).not.toBeNull();
    expect(
      (await db.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).status,
    ).toBe('TRANSFERRED_BACKOFFICE');
    expect(await db.prisma.outboxEvent.count({ where: { type: 'ConversationTransferred' } })).toBe(
      1,
    );
  });
});

describe('PrismaSessionRepository', () => {
  it('guarda y lee el estado de la sesión', async () => {
    const repo = new PrismaSessionRepository(db.prisma);
    expect(await repo.get('robot')).toBeNull();
    const rec = {
      robotUser: 'robot',
      status: 'DOWN' as const,
      lastHeartbeat: new Date(),
      lastLoginAt: null,
      consecutiveFails: 3,
    };
    await repo.save(rec);
    await repo.save({ ...rec, consecutiveFails: 3 });
    expect(await repo.get('robot')).toMatchObject({ status: 'DOWN', consecutiveFails: 3 });
  });
});
