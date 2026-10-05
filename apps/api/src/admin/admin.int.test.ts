import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { KILL_SWITCH_KEY } from '@abaya/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, AdminAuthGuard } from './admin-auth.guard.js';
import { AdminController } from './admin.controller.js';
import { AdminService, startOfBogotaDay } from './admin.service.js';
import { MemoryFlagStore } from './flags.js';

const TOKEN = 'token-de-prueba-suficientemente-largo-123';
let db: TestDatabase;
let app: INestApplication;
let base: string;
const flags = new MemoryFlagStore();

beforeAll(async () => {
  db = await startTestDatabase();
  @Module({
    controllers: [AdminController],
    providers: [
      { provide: AdminService, useValue: new AdminService(db.prisma, flags) },
      { provide: ADMIN_TOKEN, useValue: TOKEN },
      AdminAuthGuard,
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

beforeEach(async () => {
  await db.reset();
  flags.values.clear();
});

const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
  fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-admin-user': 'operador.uno',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

describe('API de administración', () => {
  it('rechaza sin token (401) y con token incorrecto (403)', async () => {
    expect((await call('/admin/overview', {}, null)).status).toBe(401);
    expect(
      (await call('/admin/overview', {}, 'otro-token-incorrecto-de-igual-longitud')).status,
    ).toBe(403);
  });

  it('sin ADMIN_TOKEN configurado, /admin queda deshabilitado (nunca abierto)', () => {
    const guard = new AdminAuthGuard(undefined);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as never;
    expect(() => guard.canActivate(ctx)).toThrow(/deshabilitada/);
  });

  it('kill switch en caliente: lo activa, lo comparte vía bandera y lo audita', async () => {
    let r = await call('/admin/kill-switch', {
      method: 'POST',
      body: JSON.stringify({ active: true }),
    });
    expect(await r.json()).toEqual({ killSwitch: true });
    expect(flags.values.get(KILL_SWITCH_KEY)).toBe('1');
    r = await call('/admin/kill-switch');
    expect(await r.json()).toEqual({ killSwitch: true });
    await call('/admin/kill-switch', { method: 'POST', body: JSON.stringify({ active: false }) });
    const audit = (await (await call('/admin/audit')).json()) as {
      actor: string;
      action: string;
    }[];
    expect(audit.map((a) => `${a.actor}:${a.action}`).sort()).toEqual([
      'operador.uno:KILL_SWITCH_OFF',
      'operador.uno:KILL_SWITCH_ON',
    ]);
  });

  it('valida el cuerpo del kill switch', async () => {
    const r = await call('/admin/kill-switch', {
      method: 'POST',
      body: JSON.stringify({ active: 'sí' }),
    });
    expect(r.status).toBe(400);
  });

  it('resumen de operación sin datos personales', async () => {
    const now = new Date();
    await db.prisma.rpaSession.create({
      data: { robotUser: 'robot-01', status: 'ACTIVE', lastHeartbeat: now, consecutiveFails: 0 },
    });
    const c = await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-1', robotUser: 'robot-01', status: 'TRANSFERRED_BACKOFFICE' },
    });
    await db.prisma.conversation.create({ data: { abayaChatId: 'CH-2', robotUser: 'robot-01' } });
    await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-3', robotUser: 'robot-01', status: 'NEEDS_REVIEW' },
    });
    await db.prisma.sale.create({
      data: {
        conversationId: c.id,
        process: 'LINEA_NUEVA',
        planCode: 'L1',
        summaryEncrypted: new Uint8Array(Buffer.from('Cliente: Ana Pérez')),
        transferredAt: now,
      },
    });
    const body = await (await call('/admin/overview')).json();
    expect(body).toMatchObject({
      killSwitch: false,
      sessions: [{ robotUser: 'robot-01', status: 'ACTIVE' }],
      conversations: { active: 1, needsReview: 1 },
      sales: { today: 1, transferredToday: 1 },
    });
    expect(JSON.stringify(body)).not.toContain('Ana');
    const review = (await (await call('/admin/review')).json()) as {
      conversations: { abayaChatId: string }[];
    };
    expect(review.conversations.map((x: { abayaChatId: string }) => x.abayaChatId)).toEqual([
      'CH-3',
    ]);
  });

  it('reset de sesión: solo si estaba en DOWN, y queda auditado', async () => {
    await db.prisma.rpaSession.create({
      data: {
        robotUser: 'robot-01',
        status: 'DOWN',
        lastHeartbeat: new Date(),
        consecutiveFails: 3,
      },
    });
    let r = (await (await call('/admin/sessions/robot-01/reset', { method: 'POST' })).json()) as {
      reset: boolean;
    };
    expect(r.reset).toBe(true);
    expect(
      await db.prisma.rpaSession.findUnique({ where: { robotUser: 'robot-01' } }),
    ).toMatchObject({
      status: 'RELOGGING',
      consecutiveFails: 0,
    });
    r = (await (await call('/admin/sessions/robot-01/reset', { method: 'POST' })).json()) as {
      reset: boolean;
    };
    expect(r.reset).toBe(false);
    expect(await db.prisma.adminAuditLog.count({ where: { action: 'SESSION_RESET' } })).toBe(1);
  });
});

describe('startOfBogotaDay', () => {
  it('usa la medianoche de Bogotá (UTC-5)', () => {
    // 03:00 UTC del 6 = 22:00 del 5 en Bogotá → el día empieza el 5 a las 05:00 UTC.
    expect(startOfBogotaDay(new Date('2026-10-06T03:00:00Z')).toISOString()).toBe(
      '2026-10-05T05:00:00.000Z',
    );
    expect(startOfBogotaDay(new Date('2026-10-06T12:00:00Z')).toISOString()).toBe(
      '2026-10-06T05:00:00.000Z',
    );
  });
});
