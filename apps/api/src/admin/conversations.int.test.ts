import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FieldCipher, GENESIS_HASH, chainHash, sha256 } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { consentAad, inboundAad, outboundAad, profileAad, saleAad } from '@abaya/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AuthController, COOKIE_SECURE } from './auth.controller.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService, stagePath } from './conversations.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

let db: TestDatabase;
let app: INestApplication;
let base: string;
let users: UsersService;
const cipher = new FieldCipher(randomBytes(32).toString('base64'));

beforeAll(async () => {
  db = await startTestDatabase();
  users = new UsersService(db.prisma);
  @Module({
    controllers: [AuthController, UsersController, ConversationsController],
    providers: [
      { provide: UsersService, useValue: users },
      {
        provide: ConversationsService,
        useValue: new ConversationsService(db.prisma, cipher, { retentionDays: 90 }),
      },
      { provide: COOKIE_SECURE, useValue: true },
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
});

const PANEL = { 'x-requested-with': 'abaya-panel', 'content-type': 'application/json' };
const get = (path: string, cookie: string) => fetch(base + path, { headers: { ...PANEL, cookie } });
/** Usuario listo (contraseña temporal ya cambiada). */
async function ready(username: string, role: 'ADMIN' | 'OPERADOR') {
  const { user, temporaryPassword } = await users.create('prueba', { username, role });
  await db.prisma.adminUser.update({
    where: { id: user.id },
    data: { mustChangePassword: false },
  });
  const r = await fetch(base + '/admin/auth/login', {
    method: 'POST',
    headers: PANEL,
    body: JSON.stringify({ username, password: temporaryPassword }),
  });
  expect(r.status).toBe(200);
  return { cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
}

/** Conversación con mensajes cifrados como los guarda el worker. */
async function seedConversation(opts: {
  chat: string;
  robot?: string;
  status?: 'ACTIVE' | 'TRANSFERRED_BACKOFFICE' | 'CLOSED_NO_SALE' | 'NEEDS_REVIEW';
  name?: string;
  createdAt?: Date;
  texts?: [string, string][]; // [cliente, robot]
  sale?: boolean;
}) {
  const createdAt = opts.createdAt ?? new Date(Date.now() - 60 * 60_000);
  const c = await db.prisma.conversation.create({
    data: {
      abayaChatId: opts.chat,
      robotUser: opts.robot ?? 'robot-01',
      status: opts.status ?? 'ACTIVE',
      stage: opts.sale ? 'TRANSFERENCIA' : 'OFERTA',
      createdAt,
    },
  });
  await db.prisma.conversation.update({
    where: { id: c.id },
    data: {
      profileEncrypted: new Uint8Array(
        cipher.encrypt(
          JSON.stringify({ name: opts.name, process: 'PORTABILIDAD', currentOperator: 'Movistar' }),
          profileAad(c.id),
        ),
      ),
    },
  });
  let t = createdAt.getTime();
  for (const [client, bot] of opts.texts ?? [['Hola', '¡Hola! ¿En qué te ayudo?']]) {
    const fp = randomUUID();
    await db.prisma.message.create({
      data: {
        conversationId: c.id,
        direction: 'INBOUND',
        fingerprint: fp,
        bodyEncrypted: new Uint8Array(cipher.encrypt(client, inboundAad(fp))),
        occurredAt: new Date((t += 1_000)),
        processedAt: new Date(t),
      },
    });
    const key = randomUUID();
    await db.prisma.message.create({
      data: {
        conversationId: c.id,
        direction: 'OUTBOUND',
        idempotencyKey: key,
        bodyEncrypted: new Uint8Array(cipher.encrypt(bot, outboundAad(key))),
        status: 'SENT_VERIFIED',
        occurredAt: new Date((t += 1_000)),
        respondsToAt: new Date(t - 1_000),
        sentAt: new Date(t + 1_500),
      },
    });
  }
  if (opts.sale) {
    await db.prisma.sale.create({
      data: {
        conversationId: c.id,
        process: 'PORTABILIDAD',
        planCode: 'P1',
        summaryEncrypted: new Uint8Array(cipher.encrypt('Resumen de la venta', saleAad(c.id))),
        transferredAt: new Date(t + 5_000),
        backofficeNoteOk: true,
      },
    });
    const acceptedAt = new Date(t + 2_000);
    const record = {
      conversationId: c.id,
      textShownHash: 'h',
      templateVersion: 'v3',
      customerReplyHash: sha256('SÍ AUTORIZO'),
      acceptedAt: acceptedAt.toISOString(),
    };
    await db.prisma.consentEvidence.create({
      data: {
        conversationId: c.id,
        textShownHash: 'h',
        templateVersion: 'v3',
        customerReplyEncrypted: new Uint8Array(cipher.encrypt('SÍ AUTORIZO', consentAad(c.id))),
        acceptedAt,
        prevHash: GENESIS_HASH,
        hash: chainHash(GENESIS_HASH, record),
      },
    });
  }
  return c;
}

describe('trazabilidad: solo ADMIN', () => {
  it('OPERADOR → 403; cualquier ADMIN entra sin permisos extra', async () => {
    const op = await ready('operador1', 'OPERADOR');
    const admin = await ready('admin1', 'ADMIN');
    for (const path of [
      '/admin/conversations',
      '/admin/conversations/stats',
      '/admin/conversations/x',
    ]) {
      expect((await get(path, op.cookie)).status).toBe(403);
    }
    expect((await get('/admin/conversations', admin.cookie)).status).toBe(200);
    expect((await get('/admin/conversations/stats', admin.cookie)).status).toBe(200);
  });
});

describe('trazabilidad: lista, detalle y exportación', () => {
  it('lista con KPIs, descifra el nombre y filtra por tipificación', async () => {
    const { cookie } = await ready('admin1', 'ADMIN');
    await seedConversation({
      chat: 'AB-1',
      name: 'Laura Gómez',
      status: 'TRANSFERRED_BACKOFFICE',
      sale: true,
    });
    await seedConversation({
      chat: 'AB-2',
      name: 'Diego',
      status: 'CLOSED_NO_SALE',
      robot: 'robot-02',
    });
    await seedConversation({ chat: 'AB-3', status: 'ACTIVE' });

    const r = await get('/admin/conversations?range=7d', cookie);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: {
        abayaChatId: string;
        customerName: string | null;
        firstResponseMs: number;
        inbound: number;
      }[];
      total: number;
      kpis: {
        total: number;
        sales: number;
        conversionPct: number;
        byTipificacion: Record<string, number>;
      };
      retentionDays: number;
    };
    expect(body.total).toBe(3);
    expect(body.kpis).toMatchObject({ total: 3, sales: 1, conversionPct: 33.3 });
    expect(body.kpis.byTipificacion).toMatchObject({
      TRANSFERRED_BACKOFFICE: 1,
      CLOSED_NO_SALE: 1,
      ACTIVE: 1,
    });
    expect(body.retentionDays).toBe(90);
    const laura = body.items.find((i) => i.abayaChatId === 'AB-1')!;
    expect(laura.customerName).toBe('Laura Gómez');
    expect(laura.firstResponseMs).toBe(2_500);
    expect(laura.inbound).toBe(1);

    const f = (await (
      await get('/admin/conversations?range=7d&status=CLOSED_NO_SALE', cookie)
    ).json()) as {
      total: number;
    };
    expect(f.total).toBe(1);
    const byRobot = (await (
      await get('/admin/conversations?range=7d&robot=robot-02', cookie)
    ).json()) as {
      total: number;
    };
    expect(byRobot.total).toBe(1);
  });

  it('busca en el texto descifrado (sin tildes) y rechaza rangos de más de 30 días', async () => {
    const { cookie } = await ready('admin1', 'ADMIN');
    await seedConversation({ chat: 'AB-1', texts: [['Quiero portarme desde Tigo', 'Claro']] });
    await seedConversation({ chat: 'AB-2', texts: [['Hola', 'Hola']] });
    const r = (await (await get('/admin/conversations?range=7d&q=tigo', cookie)).json()) as {
      items: { abayaChatId: string }[];
    };
    expect(r.items.map((i) => i.abayaChatId)).toEqual(['AB-1']);
    const big = await get(
      '/admin/conversations?range=custom&from=2026-01-01&to=2026-03-31&q=tigo',
      cookie,
    );
    expect(big.status).toBe(400);
  });

  it('detalle completo con anterior/siguiente; la apertura queda en Auditoría una vez', async () => {
    const { cookie } = await ready('admin1', 'ADMIN');
    const old = await seedConversation({
      chat: 'AB-1',
      createdAt: new Date(Date.now() - 3 * 3_600_000),
    });
    const c = await seedConversation({
      chat: 'AB-2',
      name: 'Diego Hernández',
      status: 'TRANSFERRED_BACKOFFICE',
      sale: true,
      texts: [
        ['Hola, buenas tardes', '¡Hola! Soy Sofía'],
        ['SÍ AUTORIZO', 'Listo, te transfiero'],
      ],
    });
    const r = await get(`/admin/conversations/${c.id}?range=7d`, cookie);
    expect(r.status).toBe(200);
    const d = (await r.json()) as {
      messages: { from: string; text: string; delivery?: { status: string } }[];
      sale: { backofficeSummary: string; planCode: string };
      consent: { answer: string; chainVerified: boolean };
      profile: { name: string; currentOperator: string };
      events: { kind: string }[];
      nav: { index: number; total: number; prevId: string | null; nextId: string | null };
    };
    expect(d.messages.map((m) => m.text)).toEqual([
      'Hola, buenas tardes',
      '¡Hola! Soy Sofía',
      'SÍ AUTORIZO',
      'Listo, te transfiero',
    ]);
    expect(d.messages[1]!.delivery!.status).toBe('VERIFIED');
    expect(d.sale).toMatchObject({ planCode: 'P1', backofficeSummary: 'Resumen de la venta' });
    expect(d.consent).toMatchObject({ answer: 'SÍ AUTORIZO', chainVerified: true });
    expect(d.profile).toMatchObject({ name: 'Diego Hernández', currentOperator: 'Movistar' });
    expect(d.events.map((e) => e.kind)).toEqual(['CONSENT_RECORDED', 'TRANSFERRED']);
    expect(d.nav).toEqual({ index: 1, total: 2, prevId: null, nextId: old.id });

    await get(`/admin/conversations/${c.id}`, cookie); // refresco: no se vuelve a auditar
    const audits = await db.prisma.adminAuditLog.findMany({
      where: { action: 'CONVERSATION_VIEWED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: 'admin1', target: 'AB-2' });
    expect((await get('/admin/conversations/no-existe', cookie)).status).toBe(404);
    // También por el id del chat de Abaya (enlaces desde En vivo y Robots).
    const byChat = (await (await get('/admin/conversations/AB-2', cookie)).json()) as {
      id: string;
    };
    expect(byChat.id).toBe(c.id);
  });

  it('el CSV no trae el texto de los mensajes y la exportación queda en Auditoría', async () => {
    const { cookie } = await ready('admin1', 'ADMIN');
    const c = await seedConversation({
      chat: 'AB-1',
      name: 'Laura',
      texts: [['texto secreto', 'respuesta']],
    });
    const r = await get('/admin/conversations/export?range=7d', cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const csv = await r.text();
    expect(csv).toContain('AB-1');
    expect(csv).toContain('Laura');
    expect(csv).not.toContain('texto secreto');

    const t = await get(`/admin/conversations/export?id=${c.id}`, cookie);
    expect(await t.text()).toContain('Cliente: texto secreto');
    expect(
      await db.prisma.adminAuditLog.count({ where: { action: 'CONVERSATIONS_EXPORTED' } }),
    ).toBe(2);
  });

  it('rendimiento por robot', async () => {
    const { cookie } = await ready('admin1', 'ADMIN');
    await seedConversation({ chat: 'AB-1', status: 'TRANSFERRED_BACKOFFICE', sale: true });
    await seedConversation({ chat: 'AB-2', status: 'CLOSED_NO_SALE' });
    await seedConversation({ chat: 'AB-3', robot: 'robot-02', status: 'CLOSED_NO_SALE' });
    const s = (await (await get('/admin/conversations/stats?range=7d', cookie)).json()) as {
      total: number;
      rows: { robotUser: string; total: number; sales: number; conversionPct: number }[];
    };
    expect(s.total).toBe(3);
    expect(s.rows).toMatchObject([
      { robotUser: 'robot-01', total: 2, sales: 1, conversionPct: 50 },
      { robotUser: 'robot-02', total: 1, sales: 0, conversionPct: 0 },
    ]);
  });
});

describe('stagePath', () => {
  it('quita repeticiones seguidas y conserva los retrocesos', () => {
    expect(
      stagePath(['PERFIL', 'OFERTA', 'OBJECIONES', 'OFERTA', 'OFERTA'], 'AUTORIZACION'),
    ).toEqual(['MENU', 'PERFIL', 'OFERTA', 'OBJECIONES', 'OFERTA', 'AUTORIZACION']);
  });
});
