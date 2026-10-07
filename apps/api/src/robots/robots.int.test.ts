import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FieldCipher } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { AuthController, COOKIE_SECURE } from '../admin/auth.controller.js';
import { MemoryFlagStore } from '../admin/flags.js';
import { UsersService } from '../admin/users.service.js';
import { RobotGatewayController } from './gateway/gateway.controller.js';
import { RobotGateway } from './gateway/robot-gateway.service.js';
import { ROBOT_PACKAGE_FILE, RobotsController } from './robots.controller.js';
import { ReleaseService } from './release.service.js';
import { RobotAccessTokens } from './robot-tokens.js';
import { MemoryInboundQueue, signRelease } from '@abaya/robot-store';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { ENROLLMENT_TTL_MS, RobotsService } from './robots.service.js';

const KEY = randomBytes(32).toString('base64');
const cipher = new FieldCipher(KEY);
const flags = new MemoryFlagStore();
let db: TestDatabase;
let app: INestApplication;
let base: string;
let users: UsersService;
let tmp: string;
let gateway: RobotGateway;
/** Claves de publicación de prueba (v1.7). */
const releaseKeys = generateKeyPairSync('ed25519');
const RELEASE_PRIV = releaseKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const RELEASE_PUB = releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);

beforeAll(async () => {
  db = await startTestDatabase();
  tmp = await mkdtemp(join(tmpdir(), 'paquete-'));
  users = new UsersService(db.prisma);
  const robots = new RobotsService(
    db.prisma,
    flags,
    cipher,
    {
      nodeEnv: 'production',
      abayaBaseUrl: 'https://abaya.ejemplo',
      heartbeatMs: 30_000,
    },
    {
      now,
      maxChatsPerRobot: 3,
      tokens: new RobotAccessTokens(KEY),
      release: new ReleaseService(
        join(tmp, 'abaya-robot-windows.zip'),
        join(tmp, 'release-key.pub'),
      ),
    },
  );
  await writeFile(join(tmp, 'release-key.pub'), RELEASE_PUB);
  gateway = new RobotGateway({
    prisma: db.prisma,
    cipher,
    redisUrl: 'redis://127.0.0.1:1',
    alerts: { raise: async () => undefined },
    traceDir: tmp,
    inboundQueue: new MemoryInboundQueue(),
  });
  @Module({
    controllers: [AuthController, RobotsController, RobotGatewayController],
    providers: [
      { provide: UsersService, useValue: users },
      { provide: RobotsService, useValue: robots },
      { provide: RobotGateway, useValue: gateway },
      { provide: COOKIE_SECURE, useValue: false },
      { provide: ROBOT_PACKAGE_FILE, useValue: join(tmp, 'abaya-robot-windows.zip') },
      {
        provide: ReleaseService,
        useValue: new ReleaseService(
          join(tmp, 'abaya-robot-windows.zip'),
          join(tmp, 'release-key.pub'),
        ),
      },
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
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.reset();
  flags.values.clear();
  offsetMs = 0;
});

const call = (path: string, init: RequestInit = {}, cookie?: string) =>
  fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'abaya-panel',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
const post = (path: string, body: unknown, cookie?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body) }, cookie);

async function session(username: string, role: 'ADMIN' | 'OPERADOR') {
  const { temporaryPassword } = await users.create('prueba', { username, role });
  let r = await post('/admin/auth/login', { username, password: temporaryPassword });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  r = await post(
    '/admin/auth/password',
    { currentPassword: temporaryPassword, newPassword: 'caballo correcto batería grapa' },
    cookie,
  );
  expect(r.status).toBe(200);
  return cookie;
}

async function createRobot(admin: string, robotUser = 'robot-ventas-01') {
  const r = await post('/admin/robots', { robotUser, abayaPassword: 'Clave-Abaya-1' }, admin);
  expect(r.status).toBe(201);
  return (await r.json()) as { robotUser: string; enrollmentCode: string };
}

const enroll = (code: string, host = 'PC-01') => post('/robot-api/v1/enroll', { code, host });
/** Token de renovación → acceso (v1.6) → configuración. Devuelve la respuesta que falle. */
const config = async (refreshToken: string) => {
  const t = await post('/robot-api/v1/token', { refreshToken });
  if (t.status !== 200) return t;
  const { accessToken } = (await t.json()) as { accessToken: string };
  return fetch(base + '/robot-api/v1/config', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
};
describe('alta e instalación de robots hijos', () => {
  it('ADMIN crea el robot: contraseña cifrada en BD y nunca devuelta al panel', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    const { enrollmentCode } = await createRobot(admin);
    expect(enrollmentCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const row = await db.prisma.robot.findUniqueOrThrow({
      where: { robotUser: 'robot-ventas-01' },
    });
    expect(Buffer.from(row.abayaPasswordEncrypted!).toString('utf8')).not.toContain('Clave-Abaya');
    expect(row.enrollmentCodeHash).not.toContain(enrollmentCode.replace(/-/g, ''));
    const list = await (await call('/admin/robots', {}, admin)).text();
    const detail = await (await call('/admin/robots/robot-ventas-01', {}, admin)).text();
    for (const body of [list, detail]) {
      expect(body).not.toMatch(/Clave-Abaya|Encrypted|Hash/);
    }
    expect(
      (await post('/admin/robots', { robotUser: 'robot-ventas-01', abayaPassword: 'x' }, admin))
        .status,
    ).toBe(409);
    expect(
      (await post('/admin/robots', { robotUser: 'r', abayaPassword: 'x' }, admin)).status,
    ).toBe(400);
    expect((await post('/admin/robots', { robotUser: 'robot-02' }, admin)).status).toBe(400);
  });

  it('el código se usa una sola vez y entrega un token; el hijo recibe su configuración', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    const { enrollmentCode } = await createRobot(admin);
    expect((await enroll('AAAA-BBBB-CCCC')).status).toBe(400);
    // Se acepta en minúsculas y sin guiones (lo escribe una persona).
    const r = await enroll(enrollmentCode.toLowerCase().replace(/-/g, ' '));
    expect(r.status).toBe(201);
    const { robotUser, token } = (await r.json()) as { robotUser: string; token: string };
    expect(robotUser).toBe('robot-ventas-01');
    expect((await enroll(enrollmentCode)).status).toBe(400);

    const c = await config(token);
    expect(c.status).toBe(200);
    const body = await c.text();
    // v1.6: solo lo de Abaya. Nada de base de datos, Redis ni clave de cifrado.
    expect(JSON.parse(body)).toEqual({
      nodeEnv: 'production',
      abayaBaseUrl: 'https://abaya.ejemplo',
      robotUser: 'robot-ventas-01',
      password: 'Clave-Abaya-1',
      mfaMode: 'none',
      heartbeatMs: 30_000,
    });
    expect(body).not.toMatch(/postgres|redis|DATABASE|ENCRYPTION/i);
    expect(body).not.toContain(KEY);
    expect((await config('token-inventado-'.repeat(3))).status).toBe(401);
    const audit = await db.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => `${a.actor}:${a.action}`)).toEqual(
      expect.arrayContaining(['admin.uno:ROBOT_CREATED', 'equipo:PC-01:ROBOT_ENROLLED']),
    );
  });

  it('el código vence a las 24 h', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    const { enrollmentCode } = await createRobot(admin);
    offsetMs = ENROLLMENT_TTL_MS + 1_000;
    expect((await enroll(enrollmentCode)).status).toBe(400);
  });

  it('deshabilitar revoca la instalación; para volver se necesita un código nuevo', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    const { enrollmentCode } = await createRobot(admin);
    const { token } = (await (await enroll(enrollmentCode)).json()) as { token: string };
    expect(
      (await post('/admin/robots/robot-ventas-01/enabled', { enabled: false }, admin)).status,
    ).toBe(200);
    expect((await config(token)).status).toBe(401);
    expect((await post('/admin/robots/robot-ventas-01/enrollment-code', {}, admin)).status).toBe(
      409,
    );
    await post('/admin/robots/robot-ventas-01/enabled', { enabled: true }, admin);
    expect((await config(token)).status).toBe(401);
    const again = (await (
      await post('/admin/robots/robot-ventas-01/enrollment-code', {}, admin)
    ).json()) as { enrollmentCode: string };
    const { token: t2 } = (await (await enroll(again.enrollmentCode, 'PC-07')).json()) as {
      token: string;
    };
    expect((await config(t2)).status).toBe(200);
  });

  it('credenciales: TOTP validado y entregado al hijo; contraseña nueva', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    const { enrollmentCode } = await createRobot(admin);
    const { token } = (await (await enroll(enrollmentCode)).json()) as { token: string };
    const patch = (body: unknown) =>
      call(
        '/admin/robots/robot-ventas-01/credentials',
        { method: 'PATCH', body: JSON.stringify(body) },
        admin,
      );
    expect((await patch({ mfaMode: 'totp', totpSecret: 'no-es-base32!' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(
      (
        await patch({
          abayaPassword: 'Clave-Nueva-2',
          mfaMode: 'totp',
          totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        })
      ).status,
    ).toBe(200);
    const cfg = (await (await config(token)).json()) as Record<string, string>;
    expect(cfg).toMatchObject({
      password: 'Clave-Nueva-2',
      mfaMode: 'totp',
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    });
  });

  it('la contraseña cifrada de un robot no sirve si se copia a otro (AAD por robot)', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    await createRobot(admin, 'robot-a');
    const b = await createRobot(admin, 'robot-b');
    const a = await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-a' } });
    await db.prisma.robot.update({
      where: { robotUser: 'robot-b' },
      data: { abayaPasswordEncrypted: a.abayaPasswordEncrypted },
    });
    const { token } = (await (await enroll(b.enrollmentCode)).json()) as { token: string };
    expect((await config(token)).status).toBe(409);
  });
});

describe('permisos y pausa por robot', () => {
  it('OPERADOR ve los robots pero no los administra', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    await createRobot(admin);
    const op = await session('ana.ops', 'OPERADOR');
    expect((await call('/admin/robots', {}, op)).status).toBe(200);
    expect((await call('/admin/robots/robot-ventas-01', {}, op)).status).toBe(200);
    expect(
      (await post('/admin/robots', { robotUser: 'robot-09', abayaPassword: 'x' }, op)).status,
    ).toBe(403);
    expect((await post('/admin/robots/robot-ventas-01/pause', { paused: true }, op)).status).toBe(
      403,
    );
    expect((await post('/admin/robots/robot-ventas-01/enrollment-code', {}, op)).status).toBe(403);
    expect((await call('/admin/robots')).status).toBe(401);
  });

  it('pausar pone la bandera que revisa el robot, se ve en el panel y queda auditado', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    await createRobot(admin);
    expect(
      (await post('/admin/robots/robot-ventas-01/pause', { paused: true }, admin)).status,
    ).toBe(200);
    expect(flags.values.get('abaya:pause:robot-ventas-01')).toBe('1');
    const list = (await (await call('/admin/robots', {}, admin)).json()) as {
      robots: { robotUser: string; paused: boolean }[];
    };
    expect(list.robots[0]).toMatchObject({ robotUser: 'robot-ventas-01', paused: true });
    await post('/admin/robots/robot-ventas-01/pause', { paused: false }, admin);
    expect(flags.values.get('abaya:pause:robot-ventas-01')).toBe('0');
    expect(
      await db.prisma.adminAuditLog.count({
        where: { action: { in: ['ROBOT_PAUSED', 'ROBOT_RESUMED'] } },
      }),
    ).toBe(2);
    expect(
      (await post('/admin/robots/robot-ventas-01/pause', { paused: 'sí' }, admin)).status,
    ).toBe(400);
    expect((await post('/admin/robots/no-existe/pause', { paused: true }, admin)).status).toBe(404);
  });

  it('paquete instalador: 404 si no existe; descarga con sesión del panel', async () => {
    const op = await session('ana.ops', 'OPERADOR');
    expect((await call('/admin/robots/package', {}, op)).status).toBe(404);
    await writeFile(join(tmp, 'abaya-robot-windows.zip'), 'PK-contenido-de-prueba');
    const r = await call('/admin/robots/package', {}, op);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('abaya-robot-windows.zip');
    expect(await r.text()).toBe('PK-contenido-de-prueba');
    expect((await call('/admin/robots/package')).status).toBe(401);
  });
});

describe('estado y rendimiento por equipo', () => {
  it('estado: en línea, sin señal, apagado y caído', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    const t = new Date();
    const old = new Date(t.getTime() - 5 * 60_000);
    await db.prisma.robot.createMany({
      data: [
        { robotUser: 'r-en-linea', state: 'ONLINE', lastSeenAt: t, host: 'PC-01' },
        { robotUser: 'r-sin-senal', state: 'ONLINE', lastSeenAt: old, host: 'PC-02' },
        { robotUser: 'r-apagado', state: 'STOPPED', lastSeenAt: old, host: 'PC-03' },
        { robotUser: 'r-caido', state: 'ONLINE', lastSeenAt: t, host: 'PC-04' },
        { robotUser: 'r-deshabilitado', enabled: false },
      ],
    });
    await db.prisma.rpaSession.createMany({
      data: [
        { robotUser: 'r-en-linea', status: 'ACTIVE', lastHeartbeat: t, consecutiveFails: 0 },
        { robotUser: 'r-caido', status: 'DOWN', lastHeartbeat: t, consecutiveFails: 3 },
      ],
    });
    const { robots } = (await (await call('/admin/robots', {}, admin)).json()) as {
      robots: { robotUser: string; status: string; host: string | null }[];
    };
    expect(Object.fromEntries(robots.map((r) => [r.robotUser, r.status]))).toEqual({
      'r-apagado': 'APAGADO',
      'r-caido': 'CAIDO',
      'r-deshabilitado': 'DESHABILITADO',
      'r-en-linea': 'EN_LINEA',
      'r-sin-senal': 'SIN_SENAL',
    });
  });

  it('métricas separadas por robot: conversaciones, ventas, conversión y acciones', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    let chats = 0;
    const mkConv = async (robotUser: string, n: number, status = 'ACTIVE' as const) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const c = await db.prisma.conversation.create({
          data: { abayaChatId: `${robotUser}-${chats++}`, robotUser, status },
        });
        ids.push(c.id);
      }
      return ids;
    };
    const [sold] = await mkConv('robot-01', 1);
    await mkConv('robot-01', 3);
    await mkConv('robot-02', 2);
    await db.prisma.sale.create({
      data: {
        conversationId: sold!,
        process: 'LINEA_NUEVA',
        planCode: 'L1',
        summaryEncrypted: new Uint8Array([1]),
        transferredAt: new Date(),
      },
    });
    let i = 0;
    const act = (robotUser: string, action: string, result: string, durationMs: number) =>
      db.prisma.rpaActionLog.create({
        data: { robotUser, action, result, durationMs, prevHash: `p${i}`, hash: `h${i++}` },
      });
    for (const ms of [1000, 2000, 3000, 4000]) await act('robot-01', 'SEND', 'OK', ms);
    await act('robot-01', 'SEND', 'UNCERTAIN', 10_000);
    await act('robot-02', 'SEND', 'ERROR', 500);
    await db.prisma.robot.createMany({
      data: [{ robotUser: 'robot-01' }, { robotUser: 'robot-02' }],
    });
    // Tiempo de respuesta (v1.5): 4 s, 6 s, 8 s y 20 s en robot-01.
    const t = Date.now() - 60_000;
    for (const [k, ms] of [4_000, 6_000, 8_000, 20_000].entries()) {
      await db.prisma.message.create({
        data: {
          conversationId: sold!,
          direction: 'OUTBOUND',
          idempotencyKey: `rt-${k}`,
          bodyEncrypted: new Uint8Array([1]),
          status: 'SENT_VERIFIED',
          occurredAt: new Date(t),
          respondsToAt: new Date(t - ms),
          sentAt: new Date(t),
        },
      });
    }

    const list = (await (await call('/admin/robots?rango=7d', {}, admin)).json()) as {
      maxChatsPerRobot: number;
      robots: {
        robotUser: string;
        openChats: number;
        metrics: Record<string, number | null>;
      }[];
    };
    const { robots } = list;
    expect(list.maxChatsPerRobot).toBe(3);
    expect(robots.find((r) => r.robotUser === 'robot-01')!.openChats).toBe(4);
    expect(robots.find((r) => r.robotUser === 'robot-02')!.openChats).toBe(2);
    expect(robots.find((r) => r.robotUser === 'robot-01')!.metrics).toMatchObject({
      responses: 4,
      responseP50Ms: 7_000,
    });
    expect(robots.find((r) => r.robotUser === 'robot-01')!.metrics.responseP95Ms).toBeGreaterThan(
      17_000,
    );
    expect(robots.find((r) => r.robotUser === 'robot-02')!.metrics).toMatchObject({
      responses: 0,
      responseP95Ms: null,
    });
    const r1 = robots.find((r) => r.robotUser === 'robot-01')!.metrics;
    const r2 = robots.find((r) => r.robotUser === 'robot-02')!.metrics;
    expect(r1).toMatchObject({
      conversations: 4,
      sales: 1,
      transferred: 1,
      conversionPct: 25,
      actions: 5,
      errors: 0,
      uncertain: 1,
    });
    expect(r1.sendP95Ms).toBeGreaterThan(4000);
    expect(r2).toMatchObject({ conversations: 2, sales: 0, conversionPct: 0, errors: 1 });

    const d = (await (await call('/admin/robots/robot-01?rango=hoy', {}, admin)).json()) as {
      actions: { action: string; total: number; ok: number; p50: number }[];
      recentActions: { action: string; result: string }[];
    };
    expect(d.actions).toEqual([
      expect.objectContaining({ action: 'SEND', total: 5, ok: 4, uncertain: 1, p50: 3000 }),
    ]);
    expect(d.recentActions).toHaveLength(5);
    expect((d as unknown as { response: unknown; openChats: number }).response).toMatchObject({
      samples: 4,
      p50Ms: 7_000,
      maxMs: 20_000,
    });
    expect(d.recentActions[0]).toMatchObject({ action: 'SEND', result: 'UNCERTAIN' });
    expect((await call('/admin/robots/no-existe', {}, admin)).status).toBe(404);
  });
});

describe('trazas de error en el panel (v1.6)', () => {
  it('solo ADMIN las lista y descarga descifradas; la descarga queda auditada', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    const op = await session('ana.ops', 'OPERADOR');
    const ref = '2026-10-07T01-02-03-TRANSFER-abcd1234';
    await gateway.saveTrace('robot-ventas-01', ref, Buffer.from('PK-zip-sintetico'));
    const list = (await (await call('/admin/robots/robot-ventas-01/traces', {}, admin)).json()) as {
      ref: string;
    }[];
    expect(list.map((t) => t.ref)).toEqual([ref]);
    expect((await call('/admin/robots/robot-ventas-01/traces', {}, op)).status).toBe(403);
    const r = await call(`/admin/robots/robot-ventas-01/traces/${ref}`, {}, admin);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('PK-zip-sintetico');
    expect(await db.prisma.adminAuditLog.count({ where: { action: 'TRACE_DOWNLOADED' } })).toBe(1);
    expect(
      (await call('/admin/robots/robot-ventas-01/traces/no-existe-1234', {}, admin)).status,
    ).toBe(404);
  });
});

describe('actualizaciones de los robots (v1.7)', () => {
  async function publish(version: string, privatePem = RELEASE_PRIV) {
    const zip = Buffer.from(`PK-paquete-${version}`);
    await writeFile(join(tmp, 'abaya-robot-windows.zip'), zip);
    const signed = signRelease(
      {
        product: 'abaya-robot',
        version,
        sha256: createHash('sha256').update(zip).digest('hex'),
        size: zip.length,
        builtAt: new Date().toISOString(),
      },
      privatePem,
    );
    await writeFile(join(tmp, 'abaya-robot-windows.zip.manifest.json'), JSON.stringify(signed));
    await new Promise((r) => setTimeout(r, 20)); // cambia la fecha del archivo (caché)
  }

  it('solo se ofrece una versión con firma válida; ADMIN pide la actualización', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    await createRobot(admin);
    await db.prisma.robot.update({
      where: { robotUser: 'robot-ventas-01' },
      data: { version: '1.0.0' },
    });

    // Firmada con otra clave: no se ofrece.
    const other = generateKeyPairSync('ed25519').privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    await publish('1.1.0', other.toString());
    let list = (await (await call('/admin/robots', {}, admin)).json()) as {
      published: { version: string; signatureValid: boolean } | null;
    };
    expect(list.published).toMatchObject({ version: '1.1.0', signatureValid: false });
    expect((await post('/admin/robots/robot-ventas-01/update', {}, admin)).status).toBe(409);

    await publish('1.1.0');
    list = (await (await call('/admin/robots', {}, admin)).json()) as typeof list;
    expect(list.published).toMatchObject({ version: '1.1.0', signatureValid: true });
    const r = await post('/admin/robots/robot-ventas-01/update', {}, admin);
    expect(r.status).toBe(200);
    expect(
      await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-ventas-01' } }),
    ).toMatchObject({
      updateRequested: true,
      updateStatus: 'PENDING',
      updateVersion: '1.1.0',
    });
    expect(
      await db.prisma.adminAuditLog.count({ where: { action: 'ROBOT_UPDATE_REQUESTED' } }),
    ).toBe(1);
    expect((await post('/admin/robots/robot-ventas-01/update/cancel', {}, admin)).status).toBe(200);
    expect((await post('/admin/robots/update-all', {}, admin)).status).toBe(200);
    const op = await session('ana.ops', 'OPERADOR');
    expect((await post('/admin/robots/update-all', {}, op)).status).toBe(403);
  });

  it('el robot descarga manifiesto y paquete por la pasarela y reporta el resultado', async () => {
    const admin = await session('admin.uno', 'ADMIN');
    const { enrollmentCode } = await createRobot(admin);
    const { token } = (await (await enroll(enrollmentCode)).json()) as { token: string };
    const t = await post('/robot-api/v1/token', { refreshToken: token });
    const { accessToken } = (await t.json()) as { accessToken: string };
    const auth = { headers: { authorization: `Bearer ${accessToken}` } };
    await rm(join(tmp, 'abaya-robot-windows.zip.manifest.json'), { force: true });
    expect((await fetch(base + '/robot-api/v1/release', auth)).status).toBe(404);
    await publish('1.2.0');
    const m = (await (await fetch(base + '/robot-api/v1/release', auth)).json()) as {
      manifest: string;
    };
    expect(JSON.parse(m.manifest)).toMatchObject({ version: '1.2.0' });
    expect(await (await fetch(base + '/robot-api/v1/release/package', auth)).text()).toBe(
      'PK-paquete-1.2.0',
    );
    expect((await fetch(base + '/robot-api/v1/release/package')).status).toBe(401);

    await robotsUpdate(admin);
    const report = await fetch(base + '/robot-api/v1/rpc', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'update.report',
        params: { status: 'ROLLED_BACK', version: '1.2.0', message: 'no arrancó' },
      }),
    });
    expect(report.status).toBe(200);
    // Terminada mal: no se vuelve a intentar sola.
    expect(
      await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-ventas-01' } }),
    ).toMatchObject({
      updateRequested: false,
      updateStatus: 'ROLLED_BACK',
      updateMessage: 'no arrancó',
    });
  });

  async function robotsUpdate(admin: string) {
    expect((await post('/admin/robots/robot-ventas-01/update', {}, admin)).status).toBe(200);
  }
});
