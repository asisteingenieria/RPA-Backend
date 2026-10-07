import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { KILL_SWITCH_KEY } from '@abaya/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminController } from './admin.controller.js';
import { AdminService, startOfBogotaDay } from './admin.service.js';
import { AuthController, COOKIE_SECURE } from './auth.controller.js';
import { MemoryFlagStore } from './flags.js';
import { UsersController } from './users.controller.js';
import { LOCK_MS, SESSION_IDLE_MS, UsersService } from './users.service.js';

let db: TestDatabase;
let app: INestApplication;
let base: string;
let users: UsersService;
const flags = new MemoryFlagStore();
/** Reloj del servicio de usuarios, desplazable para probar bloqueos y vencimientos. */
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);

beforeAll(async () => {
  db = await startTestDatabase();
  users = new UsersService(db.prisma, now);
  @Module({
    controllers: [AuthController, AdminController, UsersController],
    providers: [
      { provide: AdminService, useValue: new AdminService(db.prisma, flags) },
      { provide: UsersService, useValue: users },
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
  flags.values.clear();
  offsetMs = 0;
});

const PANEL = { 'x-requested-with': 'abaya-panel' };

const call = (path: string, init: RequestInit = {}, cookie?: string) =>
  fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...PANEL,
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });

const post = (path: string, body: unknown, cookie?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body) }, cookie);

async function login(username: string, password: string) {
  const r = await post('/admin/auth/login', { username, password });
  const setCookie = r.headers.get('set-cookie') ?? '';
  return { r, setCookie, cookie: setCookie.split(';')[0]! };
}

const NEW_PASSWORD = 'caballo correcto batería grapa';

/** Usuario listo para operar: creado, primer ingreso y contraseña temporal cambiada. */
async function ready(username: string, role: 'ADMIN' | 'OPERADOR') {
  const { temporaryPassword } = await users.create('prueba', { username, role });
  const { cookie } = await login(username, temporaryPassword);
  const r = await post(
    '/admin/auth/password',
    { currentPassword: temporaryPassword, newPassword: NEW_PASSWORD },
    cookie,
  );
  expect(r.status).toBe(200);
  return cookie;
}

describe('autenticación del panel', () => {
  it('sin sesión o con una cookie inventada responde 401 (nunca abierto)', async () => {
    expect((await call('/admin/overview')).status).toBe(401);
    expect((await call('/admin/overview', {}, 'abaya_admin=inventada')).status).toBe(401);
  });

  it('login: cookie httpOnly/SameSite=Strict/Secure; error genérico con contraseña mala', async () => {
    const { temporaryPassword } = await users.create('prueba', {
      username: 'ana.ops',
      role: 'OPERADOR',
    });
    let res = await login('ana.ops', 'otra-contraseña-equivocada');
    expect(res.r.status).toBe(401);
    const unknown = await login('no.existe', 'otra-contraseña-equivocada');
    expect(unknown.r.status).toBe(401);
    expect(await unknown.r.text()).toBe(await res.r.text());

    res = await login('  ANA.OPS ', temporaryPassword);
    expect(res.r.status).toBe(200);
    expect(await res.r.json()).toEqual({
      username: 'ana.ops',
      role: 'OPERADOR',
      mustChangePassword: true,
      knowledgePublisher: false,
    });
    expect(res.setCookie).toMatch(
      /^abaya_admin=[\w-]{43}; Path=\/admin; HttpOnly; SameSite=Strict/,
    );
    expect(res.setCookie).toContain('Secure');
    // El token nunca se guarda en claro.
    const token = res.cookie.split('=')[1]!;
    const s = await db.prisma.adminSession.findFirstOrThrow();
    expect(s.tokenHash).not.toBe(token);
    expect(s.tokenHash).toHaveLength(64);
  });

  it('las peticiones que cambian algo exigen la cabecera del panel (CSRF)', async () => {
    const cookie = await ready('admin.uno', 'ADMIN');
    const r = await fetch(base + '/admin/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ active: true }),
    });
    expect(r.status).toBe(403);
    expect(flags.values.get(KILL_SWITCH_KEY)).toBeUndefined();
  });

  it('contraseña temporal: solo permite /me y el cambio de contraseña hasta cambiarla', async () => {
    const { temporaryPassword } = await users.create('prueba', {
      username: 'ana.ops',
      role: 'OPERADOR',
    });
    const { cookie } = await login('ana.ops', temporaryPassword);
    const blocked = await call('/admin/overview', {}, cookie);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    expect((await call('/admin/auth/me', {}, cookie)).status).toBe(200);

    let r = await post(
      '/admin/auth/password',
      { currentPassword: temporaryPassword, newPassword: 'corta' },
      cookie,
    );
    expect(r.status).toBe(400);
    r = await post(
      '/admin/auth/password',
      { currentPassword: 'no-es-la-actual-xx', newPassword: NEW_PASSWORD },
      cookie,
    );
    expect(r.status).toBe(400);
    r = await post(
      '/admin/auth/password',
      { currentPassword: temporaryPassword, newPassword: NEW_PASSWORD },
      cookie,
    );
    expect(r.status).toBe(200);
    expect((await call('/admin/overview', {}, cookie)).status).toBe(200);
    expect((await login('ana.ops', temporaryPassword)).r.status).toBe(401);
    expect((await login('ana.ops', NEW_PASSWORD)).r.status).toBe(200);
  });

  it('bloquea la cuenta 15 min tras 5 contraseñas incorrectas, aunque luego acierte', async () => {
    await ready('ana.ops', 'OPERADOR');
    for (let i = 0; i < 5; i++) await login('ana.ops', 'contraseña-equivocada-x');
    expect((await login('ana.ops', NEW_PASSWORD)).r.status).toBe(401);
    expect(await db.prisma.adminAuditLog.count({ where: { action: 'USER_LOCKED' } })).toBe(1);
    offsetMs = LOCK_MS + 1_000;
    expect((await login('ana.ops', NEW_PASSWORD)).r.status).toBe(200);
  });

  it('la sesión vence por inactividad y el logout la invalida', async () => {
    const cookie = await ready('ana.ops', 'OPERADOR');
    offsetMs = SESSION_IDLE_MS + 1_000;
    expect((await call('/admin/overview', {}, cookie)).status).toBe(401);
    offsetMs = 0;
    const { cookie: c2 } = await login('ana.ops', NEW_PASSWORD);
    expect((await call('/admin/overview', {}, c2)).status).toBe(200);
    const out = await post('/admin/auth/logout', {}, c2);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await call('/admin/overview', {}, c2)).status).toBe(401);
  });
});

describe('permisos por rol', () => {
  it('OPERADOR: consulta y detiene el robot, pero no lo reanuda ni administra', async () => {
    const op = await ready('ana.ops', 'OPERADOR');
    expect((await call('/admin/overview', {}, op)).status).toBe(200);
    expect((await call('/admin/review', {}, op)).status).toBe(200);
    expect((await call('/admin/audit', {}, op)).status).toBe(403);
    expect((await call('/admin/users', {}, op)).status).toBe(403);
    expect((await post('/admin/users', { username: 'x.y.z', role: 'ADMIN' }, op)).status).toBe(403);
    expect((await post('/admin/sessions/robot-01/reset', {}, op)).status).toBe(403);
    expect((await post('/admin/kill-switch', { active: true }, op)).status).toBe(201);
    expect(flags.values.get(KILL_SWITCH_KEY)).toBe('1');
    expect((await post('/admin/kill-switch', { active: false }, op)).status).toBe(403);
    expect(flags.values.get(KILL_SWITCH_KEY)).toBe('1');
  });
});

describe('gestión de usuarios (ADMIN)', () => {
  it('crea usuarios con contraseña temporal que no queda guardada ni auditada en claro', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    const r = await post('/admin/users', { username: 'Luis.Ops', role: 'OPERADOR' }, admin);
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      user: { username: string; role: string; mustChangePassword: boolean };
      temporaryPassword: string;
    };
    expect(body.user).toMatchObject({
      username: 'luis.ops',
      role: 'OPERADOR',
      mustChangePassword: true,
    });
    expect(body.temporaryPassword).toHaveLength(16);
    expect(JSON.stringify(body.user)).not.toContain('passwordHash');

    const list = await (await call('/admin/users', {}, admin)).json();
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|scrypt/);
    const audit = await (await call('/admin/audit', {}, admin)).json();
    expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'admin.uno',
          action: 'USER_CREATED',
          target: 'luis.ops:OPERADOR',
        }),
      ]),
    );
    expect((await login('luis.ops', body.temporaryPassword)).r.status).toBe(200);
  });

  it('valida el usuario, el rol y los duplicados', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    expect((await post('/admin/users', { username: 'a', role: 'ADMIN' }, admin)).status).toBe(400);
    expect(
      (await post('/admin/users', { username: 'con espacio', role: 'ADMIN' }, admin)).status,
    ).toBe(400);
    expect((await post('/admin/users', { username: 'luis.ops', role: 'ROOT' }, admin)).status).toBe(
      400,
    );
    expect(
      (await post('/admin/users', { username: 'admin.uno', role: 'OPERADOR' }, admin)).status,
    ).toBe(409);
  });

  it('desactivar cierra las sesiones del usuario; reactivar le permite volver a entrar', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    const op = await ready('ana.ops', 'OPERADOR');
    const { id } = await db.prisma.adminUser.findUniqueOrThrow({ where: { username: 'ana.ops' } });
    const patch = (body: unknown) =>
      call(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, admin);

    expect((await patch({ active: false })).status).toBe(200);
    expect((await call('/admin/overview', {}, op)).status).toBe(401);
    expect((await login('ana.ops', NEW_PASSWORD)).r.status).toBe(401);
    expect((await patch({ active: true, role: 'ADMIN' })).status).toBe(200);
    const again = await login('ana.ops', NEW_PASSWORD);
    expect(await again.r.json()).toMatchObject({ role: 'ADMIN' });
    expect((await patch({})).status).toBe(400);
    expect((await patch({ active: 'no' })).status).toBe(400);
  });

  it('nadie se quita el rol ni se desactiva a sí mismo', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    const { id } = await db.prisma.adminUser.findUniqueOrThrow({
      where: { username: 'admin.uno' },
    });
    for (const body of [{ active: false }, { role: 'OPERADOR' }]) {
      const r = await call(
        `/admin/users/${id}`,
        { method: 'PATCH', body: JSON.stringify(body) },
        admin,
      );
      expect(r.status).toBe(403);
    }
    expect((await post(`/admin/users/${id}/reset-password`, {}, admin)).status).toBe(403);
  });

  it('siempre queda al menos un ADMIN activo, incluso con cambios simultáneos', async () => {
    await users.create('prueba', { username: 'admin.uno', role: 'ADMIN' });
    await users.create('prueba', { username: 'admin.dos', role: 'ADMIN' });
    const [a, b] = await db.prisma.adminUser.findMany({ orderBy: { username: 'asc' } });
    const me = (u: typeof a) => ({
      id: u!.id,
      username: u!.username,
      role: u!.role,
      mustChangePassword: false,
      knowledgePublisher: false,
      sessionId: 'x',
    });
    // Cada uno intenta quitarle el rol al otro a la vez: solo uno puede ganar.
    const results = await Promise.allSettled([
      users.update(me(a), b!.id, { role: 'OPERADOR' }),
      users.update(me(b), a!.id, { role: 'OPERADOR' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.prisma.adminUser.count({ where: { role: 'ADMIN', active: true } })).toBe(1);
  });

  it('restablecer contraseña: nueva temporal, desbloquea y cierra sesiones', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    const op = await ready('ana.ops', 'OPERADOR');
    for (let i = 0; i < 5; i++) await login('ana.ops', 'contraseña-equivocada-x');
    const { id } = await db.prisma.adminUser.findUniqueOrThrow({ where: { username: 'ana.ops' } });
    const r = await post(`/admin/users/${id}/reset-password`, {}, admin);
    expect(r.status).toBe(201);
    const { temporaryPassword } = (await r.json()) as { temporaryPassword: string };
    expect((await call('/admin/overview', {}, op)).status).toBe(401);
    expect((await login('ana.ops', NEW_PASSWORD)).r.status).toBe(401);
    const again = await login('ana.ops', temporaryPassword);
    expect(await again.r.json()).toMatchObject({ mustChangePassword: true });
  });

  it('consola: crea el primer ADMIN y solo restablece con --reset', async () => {
    const first = await users.bootstrapAdmin('Admin.Inicial', { reset: false });
    expect(first).toMatchObject({
      created: true,
      user: { username: 'admin.inicial', role: 'ADMIN' },
    });
    await expect(users.bootstrapAdmin('admin.inicial', { reset: false })).rejects.toThrow(
      /--reset/,
    );
    const again = await users.bootstrapAdmin('admin.inicial', { reset: true });
    expect(again.created).toBe(false);
    expect((await login('admin.inicial', first.temporaryPassword)).r.status).toBe(401);
    expect((await login('admin.inicial', again.temporaryPassword)).r.status).toBe(200);
  });
});

describe('operación del robot', () => {
  it('kill switch en caliente: lo activa, lo comparte vía bandera y lo audita', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    let r = await post('/admin/kill-switch', { active: true }, admin);
    expect(await r.json()).toEqual({ killSwitch: true });
    expect(flags.values.get(KILL_SWITCH_KEY)).toBe('1');
    r = await call('/admin/kill-switch', {}, admin);
    expect(await r.json()).toEqual({ killSwitch: true });
    await post('/admin/kill-switch', { active: false }, admin);
    const audit = (await (await call('/admin/audit', {}, admin)).json()) as {
      actor: string;
      action: string;
    }[];
    expect(
      audit
        .filter((a) => a.action.startsWith('KILL'))
        .map((a) => `${a.actor}:${a.action}`)
        .sort(),
    ).toEqual(['admin.uno:KILL_SWITCH_OFF', 'admin.uno:KILL_SWITCH_ON']);
  });

  it('valida el cuerpo del kill switch', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    expect((await post('/admin/kill-switch', { active: 'sí' }, admin)).status).toBe(400);
  });

  it('resumen de operación sin datos personales', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    const at = new Date();
    await db.prisma.rpaSession.create({
      data: { robotUser: 'robot-01', status: 'ACTIVE', lastHeartbeat: at, consecutiveFails: 0 },
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
        transferredAt: at,
      },
    });
    const body = await (await call('/admin/overview', {}, admin)).json();
    expect(body).toMatchObject({
      killSwitch: false,
      sessions: [{ robotUser: 'robot-01', status: 'ACTIVE' }],
      conversations: { active: 1, needsReview: 1 },
      sales: { today: 1, transferredToday: 1 },
    });
    expect(JSON.stringify(body)).not.toContain('Ana');
    const review = (await (await call('/admin/review', {}, admin)).json()) as {
      conversations: { abayaChatId: string }[];
    };
    expect(review.conversations.map((x) => x.abayaChatId)).toEqual(['CH-3']);
  });

  it('reset de sesión: solo si estaba en DOWN, y queda auditado', async () => {
    const admin = await ready('admin.uno', 'ADMIN');
    await db.prisma.rpaSession.create({
      data: {
        robotUser: 'robot-01',
        status: 'DOWN',
        lastHeartbeat: new Date(),
        consecutiveFails: 3,
      },
    });
    let r = (await (await post('/admin/sessions/robot-01/reset', {}, admin)).json()) as {
      reset: boolean;
    };
    expect(r.reset).toBe(true);
    expect(
      await db.prisma.rpaSession.findUnique({ where: { robotUser: 'robot-01' } }),
    ).toMatchObject({ status: 'RELOGGING', consecutiveFails: 0 });
    r = (await (await post('/admin/sessions/robot-01/reset', {}, admin)).json()) as {
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

// Debe ir al final: deja bloqueada la IP local para el resto del archivo.
describe('bloqueo por IP', () => {
  it('tras 10 logins fallidos desde la misma IP responde 429, incluso con la contraseña correcta', async () => {
    await ready('ana.ops', 'OPERADOR');
    for (let i = 0; i < 10; i++) await login(`usuario.${i}`, 'contraseña-equivocada-x');
    expect((await login('ana.ops', NEW_PASSWORD)).r.status).toBe(429);
  });
});
