import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FieldCipher } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { inboundAad, outboundAad, profileAad } from '@abaya/domain';
import { MemoryLiveBus } from '@abaya/robot-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AuthController, COOKIE_SECURE } from './auth.controller.js';
import { ConversationsService } from './conversations.service.js';
import { LIVE_BUS, LiveController } from './live.controller.js';
import { byBoardOrder, LiveService, type LiveChatCard } from './live.service.js';
import { UsersService } from './users.service.js';

// Monitor en vivo (D-032) contra PostgreSQL real (temporal): solo ADMIN, contenido descifrado
// solo en la respuesta, cambios empujados por SSE y cada vista en Auditoría.

let db: TestDatabase;
let app: INestApplication;
let base: string;
let users: UsersService;
let live: LiveService;
const bus = new MemoryLiveBus();
const cipher = new FieldCipher(randomBytes(32).toString('base64'));

beforeAll(async () => {
  db = await startTestDatabase();
  users = new UsersService(db.prisma);
  const conversations = new ConversationsService(db.prisma, cipher, { retentionDays: 90 });
  live = new LiveService(db.prisma, conversations, bus, () => new Date(), 100);
  @Module({
    controllers: [AuthController, LiveController],
    providers: [
      { provide: UsersService, useValue: users },
      { provide: LiveService, useValue: live },
      { provide: LIVE_BUS, useValue: bus },
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
  live?.close();
  await app?.close();
  await db?.stop();
});

beforeEach(async () => {
  await db.reset();
  bus.activity.clear();
  bus.watched.clear();
  bus.last.clear();
});

const PANEL = { 'x-requested-with': 'abaya-panel', 'content-type': 'application/json' };

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

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Abre un stream SSE y acumula sus eventos. */
async function open(path: string, cookie: string) {
  const ac = new AbortController();
  const res = await fetch(base + path, { headers: { cookie }, signal: ac.signal });
  const events: SseEvent[] = [];
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        // cerrado por la prueba
      }
    })();
  }
  const until = async (pred: (e: SseEvent) => boolean, ms = 5_000) => {
    const t = Date.now();
    for (;;) {
      const e = events.find(pred);
      if (e) return e;
      if (Date.now() - t > ms) throw new Error('evento no llegó');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { res, events, until, close: () => ac.abort() };
}

async function seed(chat: string, robot = 'robot-01') {
  const c = await db.prisma.conversation.create({
    data: { abayaChatId: chat, robotUser: robot, status: 'ACTIVE', stage: 'OFERTA' },
  });
  await db.prisma.conversation.update({
    where: { id: c.id },
    data: {
      profileEncrypted: new Uint8Array(
        cipher.encrypt(
          JSON.stringify({ name: 'Cliente Sintético', process: 'MIGRACION' }),
          profileAad(c.id),
        ),
      ),
    },
  });
  await inbound(c.id, 'Hola, quiero un plan', new Date(Date.now() - 60_000));
  const key = randomUUID();
  await db.prisma.message.create({
    data: {
      conversationId: c.id,
      direction: 'OUTBOUND',
      idempotencyKey: key,
      bodyEncrypted: new Uint8Array(
        cipher.encrypt('¡Hola! Te muestro los planes', outboundAad(key)),
      ),
      status: 'SENT_VERIFIED',
      occurredAt: new Date(Date.now() - 50_000),
      sentAt: new Date(Date.now() - 49_000),
    },
  });
  return c;
}

async function inbound(conversationId: string, text: string, at = new Date()) {
  const fp = randomUUID();
  await db.prisma.message.create({
    data: {
      conversationId,
      direction: 'INBOUND',
      fingerprint: fp,
      bodyEncrypted: new Uint8Array(cipher.encrypt(text, inboundAad(fp))),
      occurredAt: at,
    },
  });
}

const audits = async (action: string) =>
  db.prisma.adminAuditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

describe('acceso', () => {
  it('sin sesión 401; OPERADOR 403 (tablero y pantalla)', async () => {
    expect((await fetch(base + '/admin/live/stream')).status).toBe(401);
    const op = await ready('operador1', 'OPERADOR');
    expect((await fetch(base + '/admin/live/stream', { headers: op })).status).toBe(403);
    expect((await fetch(base + '/admin/live/robots/robot-01/screen', { headers: op })).status).toBe(
      403,
    );
  });
});

describe('conversaciones en vivo', () => {
  it('tablero: cada robot con lo que hace y sus chats (contenido descifrado), auditado', async () => {
    await db.prisma.robot.create({ data: { robotUser: 'robot-01', host: 'PC-01' } });
    await seed('7001');
    await bus.setActivity('robot-01', {
      action: 'SEND',
      abayaChatId: '7001',
      since: new Date().toISOString(),
      queued: 1,
    });
    const admin = await ready('admin1', 'ADMIN');
    const s = await open('/admin/live/stream', admin.cookie);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(s.res.headers.get('x-accel-buffering')).toBe('no');

    const board = (await s.until((e) => e.event === 'board')).data as {
      robots: {
        robotUser: string;
        host: string;
        activity: { action: string; abayaChatId: string };
        chats: Record<string, unknown>[];
      }[];
    };
    const robot = board.robots.find((r) => r.robotUser === 'robot-01')!;
    expect(robot.host).toBe('PC-01');
    expect(robot.activity).toMatchObject({ action: 'SEND', abayaChatId: '7001' });
    expect(robot.chats).toHaveLength(1);
    expect(robot.chats[0]).toMatchObject({
      abayaChatId: '7001',
      customerName: 'Cliente Sintético',
      process: 'MIGRACION',
      stage: 'OFERTA',
      turn: 'CLIENTE',
      closed: false,
      lastMessage: { from: 'bot', text: '¡Hola! Te muestro los planes', delivery: 'VERIFIED' },
    });

    // Un mensaje nuevo del cliente llega sin pedirlo: ahora es el turno del robot.
    const conv = await db.prisma.conversation.findUniqueOrThrow({ where: { abayaChatId: '7001' } });
    await inbound(conv.id, '¿Y el más barato?');
    await s.until(
      (e) =>
        e.event === 'board' &&
        JSON.stringify(e.data).includes('¿Y el más barato?') &&
        JSON.stringify(e.data).includes('"turn":"ROBOT"'),
    );
    s.close();
    expect(await audits('LIVE_VIEWED')).toHaveLength(1);
  });

  it('chat abierto: los mensajes llegan en vivo y la apertura queda en Auditoría', async () => {
    const c = await seed('7002');
    const admin = await ready('admin2', 'ADMIN');
    const s = await open(`/admin/live/stream?chat=${c.id}`, admin.cookie);
    const first = (await s.until((e) => e.event === 'chat')).data as {
      messages: { from: string; text: string }[];
    };
    expect(first.messages.map((m) => m.text)).toEqual([
      'Hola, quiero un plan',
      '¡Hola! Te muestro los planes',
    ]);
    await inbound(c.id, 'Me interesa el de 50 GB');
    await s.until(
      (e) =>
        e.event === 'chat' &&
        (e.data.messages as { text: string }[]).some((m) => m.text === 'Me interesa el de 50 GB'),
    );
    s.close();
    const views = await audits('CONVERSATION_VIEWED');
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ actor: 'admin2', target: '7002' });

    expect(
      (await fetch(base + '/admin/live/stream?chat=no-existe', { headers: admin })).status,
    ).toBe(404);
  });
});

describe('pantalla en vivo', () => {
  it('pide la pantalla al robot mientras se mira y reenvía sus imágenes; auditado con la duración', async () => {
    await db.prisma.robot.create({ data: { robotUser: 'robot-01' } });
    const admin = await ready('admin3', 'ADMIN');
    expect((await fetch(base + '/admin/live/robots/otro/screen', { headers: admin })).status).toBe(
      404,
    );

    // La última imagen (si la hay) sale apenas se abre.
    await bus.publishFrame('robot-01', {
      jpeg: '/9j/anterior',
      width: 1280,
      height: 720,
      at: new Date().toISOString(),
    });
    const s = await open('/admin/live/robots/robot-01/screen', admin.cookie);
    expect(s.res.status).toBe(200);
    await s.until((e) => e.event === 'frame' && e.data.jpeg === '/9j/anterior');
    expect(await bus.screenWatched('robot-01')).toBe(true);

    await bus.publishFrame('robot-01', {
      jpeg: '/9j/nueva',
      width: 1280,
      height: 720,
      at: new Date().toISOString(),
    });
    await s.until((e) => e.event === 'frame' && e.data.jpeg === '/9j/nueva');
    s.close();

    const t = Date.now();
    while (!(await audits('SCREEN_VIEW_ENDED')).length && Date.now() - t < 5_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await audits('SCREEN_VIEWED')).toEqual([
      expect.objectContaining({ actor: 'admin3', target: 'robot-01' }),
    ]);
    expect((await audits('SCREEN_VIEW_ENDED'))[0]).toMatchObject({
      actor: 'admin3',
      target: 'robot-01',
      detail: { seconds: expect.any(Number) },
    });
  });
});

describe('orden de la tarjeta del robot (11/11/2026)', () => {
  const card = (id: string, status: string, minAgo: number, lastMsgMinAgo?: number) =>
    ({
      id,
      status,
      closed: !['ACTIVE', 'WAITING_CONSENT', 'TRANSFERRING', 'NEEDS_REVIEW'].includes(status),
      updatedAt: new Date(Date.now() - minAgo * 60_000).toISOString(),
      lastMessage:
        lastMsgMinAgo === undefined
          ? null
          : { at: new Date(Date.now() - lastMsgMinAgo * 60_000).toISOString() },
    }) as LiveChatCard;

  it('en curso, recién cerrados y en revisión al final; lo más reciente arriba en cada grupo', () => {
    const chats = [
      card('rev-viejo', 'NEEDS_REVIEW', 2_000, 2_000),
      card('activo-viejo', 'ACTIVE', 1, 30),
      card('cerrado', 'CLOSED_SUPPORT', 3, 4),
      card('rev-nuevo', 'NEEDS_REVIEW', 60, 60),
      card('activo-nuevo', 'ACTIVE', 1, 2),
      card('activo-sin-mensajes', 'ACTIVE', 10),
    ];
    expect(chats.sort(byBoardOrder).map((c) => c.id)).toEqual([
      'activo-nuevo',
      'activo-sin-mensajes',
      'activo-viejo',
      'cerrado',
      'rev-nuevo',
      'rev-viejo',
    ]);
  });
});
