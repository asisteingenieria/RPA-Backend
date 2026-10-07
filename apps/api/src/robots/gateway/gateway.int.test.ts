import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { FieldCipher } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { KILL_SWITCH_KEY, inboundAad, outboundAad } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import {
  MemoryInboundQueue,
  WS_CLOSE_REVOKED,
  traceAad,
  type RobotQueueHandlers,
} from '@abaya/robot-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MemoryFlagStore } from '../../admin/flags.js';
import { RobotAccessTokens } from '../robot-tokens.js';
import { ROTATION_GRACE_MS, RobotsService } from '../robots.service.js';
import { ReleaseService } from '../release.service.js';
import { RobotGatewayController } from './gateway.controller.js';
import { RobotGateway } from './robot-gateway.service.js';
import { RobotWsHub } from './ws-hub.js';

// Pasarela de robots hijos (v1.6, sección 2.8) contra PostgreSQL real (temporal).

const KEY = randomBytes(32).toString('base64');
const cipher = new FieldCipher(KEY);
const flags = new MemoryFlagStore();
const alerts = new MemoryAlertAdapter();
const queue = new MemoryInboundQueue();
const enqueued: { robotUser: string; messageId: string }[] = [];
const handlers = new Map<string, RobotQueueHandlers>();
let db: TestDatabase;
let app: INestApplication;
let base: string;
let robots: RobotsService;
let hub: RobotWsHub;
let tmp: string;
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);

beforeAll(async () => {
  db = await startTestDatabase();
  tmp = await mkdtemp(join(tmpdir(), 'pasarela-'));
  robots = new RobotsService(
    db.prisma,
    flags,
    cipher,
    { nodeEnv: 'production', abayaBaseUrl: 'https://abaya.ejemplo', heartbeatMs: 30_000 },
    { now, tokens: new RobotAccessTokens(KEY, () => now().getTime()), alerts },
  );
  const gateway = new RobotGateway({
    prisma: db.prisma,
    cipher,
    redisUrl: 'redis://127.0.0.1:1',
    alerts,
    traceDir: tmp,
    inboundQueue: queue,
    enqueueOutbound: async (robotUser, messageId) => void enqueued.push({ robotUser, messageId }),
  });
  @Module({
    controllers: [RobotGatewayController],
    providers: [
      { provide: RobotsService, useValue: robots },
      { provide: RobotGateway, useValue: gateway },
      { provide: ReleaseService, useValue: new ReleaseService(null, null) },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  hub = new RobotWsHub(app.getHttpServer() as Server, {
    robots,
    prisma: db.prisma,
    flags,
    redisUrl: 'redis://127.0.0.1:1',
    logger: createLogger('t', { level: 'silent' }),
    revalidateMs: 300,
    consumers: (robotUser, h) => {
      handlers.set(robotUser, h);
      return { close: async () => void handlers.delete(robotUser) };
    },
  });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
}, 120_000);

afterAll(async () => {
  await hub?.close();
  await app?.close();
  await db?.stop();
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.reset();
  flags.values.clear();
  alerts.raised.length = 0;
  queue.jobs.length = 0;
  enqueued.length = 0;
  offsetMs = 0;
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}/robot-api/v1/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** Robot instalado: devuelve su token de renovación vigente. */
async function install(robotUser: string): Promise<string> {
  const { enrollmentCode } = await robots.create('prueba', {
    robotUser,
    abayaPassword: 'Clave-Abaya-1',
  });
  const r = await post('enroll', { code: enrollmentCode, host: `PC-${robotUser}` });
  return ((await r.json()) as { token: string }).token;
}

async function access(refreshToken: string) {
  const r = await post('token', { refreshToken });
  expect(r.status).toBe(200);
  return (await r.json()) as { accessToken: string; refreshToken: string; robotUser: string };
}

const rpc = async (token: string, method: string, params: unknown = {}) => {
  const r = await post('rpc', { method, params }, token);
  return { status: r.status, body: (await r.json()) as { result?: unknown } };
};

describe('tokens del equipo', () => {
  it('rota el token de renovación en cada uso; el anterior solo sirve para reintentar 60 s', async () => {
    const t0 = await install('robot-a');
    const a = await access(t0);
    expect(a.refreshToken).not.toBe(t0);
    // La respuesta se perdió: el equipo reintenta con el anterior dentro de la ventana.
    const retry = await access(t0);
    expect(retry.robotUser).toBe('robot-a');
    // Con el vigente sigue funcionando.
    const b = await access(retry.refreshToken);
    expect(b.accessToken).toMatch(/^v1\./);
  });

  it('reúso del token anterior fuera de la ventana: revoca todo, alerta y audita', async () => {
    const t0 = await install('robot-a');
    const a = await access(t0);
    offsetMs = ROTATION_GRACE_MS + 1_000;
    // Alguien usa una copia vieja del archivo.
    expect((await post('token', { refreshToken: t0 })).status).toBe(401);
    expect(alerts.raised.map((x) => x.code)).toContain('ROBOT_TOKEN_REUSE');
    // El equipo legítimo también queda fuera (hay que reinstalar) y su acceso se invalida.
    expect((await post('token', { refreshToken: a.refreshToken })).status).toBe(401);
    expect((await rpc(a.accessToken, 'session.get')).status).toBe(401);
    expect(await db.prisma.adminAuditLog.count({ where: { action: 'ROBOT_TOKEN_REUSE' } })).toBe(1);
  });

  it('tokens de acceso: firma, vencimiento y revocación al deshabilitar', async () => {
    const { accessToken } = await access(await install('robot-a'));
    expect((await rpc(accessToken, 'session.get')).status).toBe(200);
    expect((await rpc(accessToken.slice(0, -2) + 'xx', 'session.get')).status).toBe(401);
    expect((await rpc('token-inventado', 'session.get')).status).toBe(401);
    offsetMs = 61 * 60_000; // venció (1 h)
    expect((await rpc(accessToken, 'session.get')).status).toBe(401);
    offsetMs = 0;
    await robots.setEnabled('admin', 'robot-a', false);
    expect((await rpc(accessToken, 'session.get')).status).toBe(401);
  });

  it('la configuración no lleva base de datos, Redis ni claves', async () => {
    const { accessToken } = await access(await install('robot-a'));
    const r = await fetch(`${base}/robot-api/v1/config`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ robotUser: 'robot-a', password: 'Clave-Abaya-1' });
    expect(text).not.toMatch(/postgres|redis|ENCRYPTION/i);
    expect(text).not.toContain(KEY);
  });
});

describe('operaciones: cada robot solo toca lo suyo', () => {
  it('guarda entrantes cifrados en el servidor y los encola para el motor', async () => {
    const { accessToken } = await access(await install('robot-a'));
    const fingerprint = 'a'.repeat(64);
    const r = await rpc(accessToken, 'inbound.store', {
      abayaChatId: 'CH-1',
      fingerprint,
      text: 'Hola, quiero un plan',
      via: 'network',
      occurredAt: new Date().toISOString(),
    });
    expect(r.body.result).toEqual({ inserted: true, conversationCreated: true });
    const m = await db.prisma.message.findFirstOrThrow({ where: { fingerprint } });
    expect(Buffer.from(m.bodyEncrypted).toString('utf8')).not.toContain('Hola');
    expect(cipher.decryptString(m.bodyEncrypted, inboundAad(fingerprint))).toBe(
      'Hola, quiero un plan',
    );
    expect(queue.jobs).toHaveLength(1);
    // Repetido: no se duplica.
    const again = await rpc(accessToken, 'inbound.store', {
      abayaChatId: 'CH-1',
      fingerprint,
      text: 'Hola, quiero un plan',
      via: 'dom',
      occurredAt: new Date().toISOString(),
    });
    expect(again.body.result).toEqual({ inserted: false, conversationCreated: false });
  });

  it('un robot no puede leer ni escribir datos de otro robot', async () => {
    const a = (await access(await install('robot-a'))).accessToken;
    const b = (await access(await install('robot-b'))).accessToken;
    const convB = await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-B', robotUser: 'robot-b' },
    });
    const msgB = await db.prisma.message.create({
      data: {
        conversationId: convB.id,
        direction: 'OUTBOUND',
        idempotencyKey: 'k-b',
        bodyEncrypted: new Uint8Array(cipher.encrypt('Respuesta para B', outboundAad('k-b'))),
        status: 'PENDING',
        occurredAt: new Date(),
      },
    });
    // B sí recibe el TEXTO de su mensaje (por TLS); A recibe 403.
    expect((await rpc(b, 'outbound.get', { messageId: msgB.id })).body.result).toMatchObject({
      text: 'Respuesta para B',
    });
    expect((await rpc(a, 'outbound.get', { messageId: msgB.id })).status).toBe(403);
    expect(
      (await rpc(a, 'outbound.setStatus', { messageId: msgB.id, status: 'SENT_VERIFIED' })).status,
    ).toBe(403);
    expect((await rpc(a, 'handoff.sale', { conversationId: convB.id })).status).toBe(403);
    expect(
      (await rpc(a, 'handoff.markTransferred', { conversationId: convB.id, target: 'BACKOFFICE' }))
        .status,
    ).toBe(403);
    expect(
      (await rpc(a, 'recovery.enqueueOutbound', { messageId: msgB.id, abayaChatId: 'CH-B' }))
        .status,
    ).toBe(403);
    // Escribir un entrante en el chat de B tampoco.
    expect(
      (
        await rpc(a, 'inbound.store', {
          abayaChatId: 'CH-B',
          fingerprint: 'b'.repeat(64),
          text: 'x',
          via: 'network',
          occurredAt: new Date().toISOString(),
        })
      ).status,
    ).toBe(403);
    expect((await db.prisma.message.findUniqueOrThrow({ where: { id: msgB.id } })).status).toBe(
      'PENDING',
    );
    // La recuperación de A solo ve lo de A.
    expect((await rpc(a, 'recovery.pendingOutbound')).body.result).toEqual([]);
    expect((await rpc(b, 'recovery.pendingOutbound')).body.result).toEqual([
      { messageId: msgB.id, abayaChatId: 'CH-B' },
    ]);
  });

  it('auditoría y alertas: el robot sale del token, no de los parámetros', async () => {
    const a = (await access(await install('robot-a'))).accessToken;
    const r = await rpc(a, 'actionLog.append', {
      action: 'SEND',
      abayaChatId: null,
      result: 'OK',
      durationMs: 120,
      traceRef: null,
      createdAt: new Date().toISOString(),
      robotUser: 'robot-b', // se ignora
    });
    expect(r.status).toBe(200);
    expect(await db.prisma.rpaActionLog.findFirstOrThrow()).toMatchObject({ robotUser: 'robot-a' });
    await rpc(a, 'alerts.raise', { code: 'SESSION_DOWN', severity: 'CRITICA', detail: {} });
    expect(alerts.raised.at(-1)).toMatchObject({
      code: 'SESSION_DOWN',
      detail: { robotUser: 'robot-a' },
    });
  });

  it('valida la operación y sus parámetros', async () => {
    const a = (await access(await install('robot-a'))).accessToken;
    expect((await rpc(a, 'db.dropTables')).status).toBe(400);
    expect((await rpc(a, 'outbound.setStatus', { messageId: 'x', status: 'BORRADO' })).status).toBe(
      400,
    );
  });

  it('trazas: el servidor las guarda cifradas; referencias inválidas se rechazan', async () => {
    const a = (await access(await install('robot-a'))).accessToken;
    const ref = '2026-10-07T00-00-00-SEND-abc12345';
    const zip = Buffer.from('PK-traza-sintetica');
    const r = await fetch(`${base}/robot-api/v1/traces/${ref}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a}`, 'content-type': 'application/octet-stream' },
      body: zip,
    });
    expect(r.status).toBe(204);
    const enc = await readFile(join(tmp, 'robots', 'robot-a', `${ref}.trace.enc`));
    expect(enc.toString('latin1')).not.toContain('PK-traza');
    expect(cipher.decrypt(enc, traceAad(ref)).toString()).toBe('PK-traza-sintetica');
    const bad = await fetch(`${base}/robot-api/v1/traces/..%2F..%2Fescape`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a}`, 'content-type': 'application/octet-stream' },
      body: zip,
    });
    expect(bad.status).toBe(400);
  });
});

describe('WebSocket: tareas y estado empujados al robot', () => {
  function connect(token: string, instanceId: string) {
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/robot-api/v1/ws?instanceId=${instanceId}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
    return { ws, frames };
  }
  const opened = (ws: WebSocket) =>
    new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('unexpected-response', (_req, r) => rej(new Error(String(r.statusCode))));
      ws.once('error', rej);
    });
  const poll = async (fn: () => boolean, ms = 3_000) => {
    const t = Date.now();
    while (!fn()) {
      if (Date.now() - t > ms) throw new Error('tiempo agotado');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('solo la instancia dueña (presencia) se conecta', async () => {
    const a = (await access(await install('robot-a'))).accessToken;
    const intruder = connect(a, randomUUID());
    await expect(opened(intruder.ws)).rejects.toThrow('409');
    const instanceId = randomUUID();
    await rpc(a, 'presence.claim', { instanceId, host: 'PC-01', version: '1.0.0' });
    const c = connect(a, instanceId);
    await opened(c.ws);
    c.ws.close();
  });

  it('empuja tareas y el kill switch; la respuesta del robot vuelve a la cola', async () => {
    const a = (await access(await install('robot-a'))).accessToken;
    const instanceId = randomUUID();
    await rpc(a, 'presence.claim', { instanceId, host: 'PC-01', version: '1.0.0' });
    const c = connect(a, instanceId);
    c.ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as { t: string; id: string; kind: string };
      if (f.t === 'job')
        c.ws.send(JSON.stringify({ t: 'result', id: f.id, ok: true, value: 'SENT_VERIFIED' }));
    });
    await opened(c.ws);
    await poll(() => c.frames.some((f) => f.t === 'flags'));
    expect(c.frames.find((f) => f.t === 'flags')).toMatchObject({
      killSwitch: false,
      paused: false,
    });

    await poll(() => handlers.has('robot-a'));
    expect(await handlers.get('robot-a')!.send('msg-1')).toBe('SENT_VERIFIED');
    expect(c.frames.find((f) => f.t === 'job')).toMatchObject({
      kind: 'send',
      data: { messageId: 'msg-1' },
    });

    flags.values.set(KILL_SWITCH_KEY, '1');
    await poll(() => c.frames.some((f) => f.t === 'flags' && f.killSwitch === true));
    c.ws.close();
  });

  it('deshabilitar el robot corta la conexión (4401) y una tarea en curso falla', async () => {
    const a = (await access(await install('robot-a'))).accessToken;
    const instanceId = randomUUID();
    await rpc(a, 'presence.claim', { instanceId, host: 'PC-01', version: '1.0.0' });
    const c = connect(a, instanceId);
    const closed = new Promise<number>((res) => c.ws.on('close', (code) => res(code)));
    await opened(c.ws);
    await poll(() => handlers.has('robot-a'));
    // El robot no responde; se observa el resultado desde ya (evita rechazos sin manejar).
    const inFlight = handlers
      .get('robot-a')!
      .send('msg-2')
      .then(
        () => 'resuelta',
        (e: Error) => e.message,
      );
    await robots.setEnabled('admin', 'robot-a', false);
    expect(await closed).toBe(WS_CLOSE_REVOKED);
    expect(await inFlight).toMatch(/desconectado/);
  });
});
