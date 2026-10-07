import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { DEFAULT_AGENT_CONFIG, type AgentTestJob, type EvalJob } from '@abaya/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AgentConfigController } from './agent-config.controller.js';
import { AgentConfigService } from './agent-config.service.js';
import { AuthController, COOKIE_SECURE } from './auth.controller.js';
import { UsersService } from './users.service.js';

let db: TestDatabase;
let app: INestApplication;
let base: string;
let users: UsersService;
const jobs: EvalJob[] = [];
const tests: AgentTestJob[] = [];

beforeAll(async () => {
  db = await startTestDatabase();
  users = new UsersService(db.prisma);
  const agent = new AgentConfigService(
    db.prisma,
    { provider: 'anthropic', defaultModel: 'modelo-a', allowedModels: ['modelo-b'] },
    { enqueue: async (job) => void jobs.push(job) },
    {
      run: async (job) => {
        tests.push(job);
        return {
          stage: 'PERFIL',
          profile: { process: 'PORTABILIDAD' },
          replies: ['¿Me compartes tu nombre?'],
          events: [],
          validation: 'NO_LLM',
          llm: [],
        };
      },
    },
  );
  @Module({
    controllers: [AuthController, AgentConfigController],
    providers: [
      { provide: UsersService, useValue: users },
      { provide: AgentConfigService, useValue: agent },
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
  jobs.length = 0;
  tests.length = 0;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON de la API en pruebas
const json = (r: Response) => r.json() as Promise<any>;

const call = (path: string, init: RequestInit = {}, cookie?: string) =>
  fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'abaya-panel',
      ...(cookie ? { cookie } : {}),
    },
  });
const put = (path: string, body: unknown, cookie: string) =>
  call(path, { method: 'PUT', body: JSON.stringify(body) }, cookie);
const post = (path: string, body: unknown, cookie?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body) }, cookie);

async function ready(username: string, role: 'ADMIN' | 'OPERADOR') {
  const { temporaryPassword } = await users.create('prueba', { username, role });
  const r = await post('/admin/auth/login', { username, password: temporaryPassword });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  await post(
    '/admin/auth/password',
    { currentPassword: temporaryPassword, newPassword: 'caballo correcto batería grapa' },
    cookie,
  );
  return cookie;
}

const { id: _id, version: _v, ...defaults } = DEFAULT_AGENT_CONFIG;
const fields = (over: Partial<typeof defaults> = {}) => ({
  ...defaults,
  agentName: 'Sofía',
  companyName: 'Empresa de prueba',
  prompt: '# Rol\n- Eres Sofía.\n\n## PERFIL\n- Pide el nombre.\n- Ofrece {{OFERTA:L1}}.',
  ...over,
});

describe('configuración del agente (v1.8)', () => {
  it('sin versiones muestra la v1 del código, las reglas del sistema y el catálogo', async () => {
    const ops = await ready('ana.ops', 'OPERADOR');
    const r = await call('/admin/agent', {}, ops);
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.published).toMatchObject({ builtIn: true, version: 1, status: 'PUBLISHED' });
    expect(body.working).toBeNull();
    expect(body.systemRules).toContain('Reglas del sistema');
    expect(body.menuOptions).toContain('*A.*');
    expect(body.models).toEqual(['modelo-a', 'modelo-b']);
    expect(body.canPublish).toBe(true);
    expect(body.temperatureApplies).toBe(false);
  });

  it('OPERADOR ve pero no puede guardar, publicar ni restaurar', async () => {
    const ops = await ready('ana.ops', 'OPERADOR');
    expect((await put('/admin/agent/draft', fields(), ops)).status).toBe(403);
    expect((await post('/admin/agent/draft/publish', {}, ops)).status).toBe(403);
    expect((await call('/admin/agent/versions', {}, ops)).status).toBe(200);
  });

  it('rechaza precios, gigas y porcentajes en el guion, con la línea (regla 11)', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const r = await put(
      '/admin/agent/draft',
      fields({
        prompt: '# Planes\n- ID L1: Precio $99.900\n- Datos: 55 GB\n- Descuento del 20%',
        welcome: '¡Hola! Te regalo un plan gratis',
      }),
      admin,
    );
    expect(r.status).toBe(400);
    const body = await json(r);
    const lines = body.issues
      .filter((i: { field: string }) => i.field === 'prompt')
      .map((i: { line: number }) => i.line);
    expect(lines).toEqual([2, 3, 4]);
    expect(body.issues.some((i: { field: string }) => i.field === 'welcome')).toBe(true);
    expect(await db.prisma.agentConfigVersion.count()).toBe(0);

    // La revisión en vivo devuelve lo mismo sin guardar.
    const live = await post('/admin/agent/review', fields({ prompt: '55 GB' }), admin);
    expect((await json(live)).issues).toHaveLength(1);
  });

  it('rechaza un modelo fuera de la lista y temperatura fuera de 0–0.3', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const r = await put(
      '/admin/agent/draft',
      fields({ model: 'otro-modelo', temperature: 0.9 }),
      admin,
    );
    expect(r.status).toBe(400);
    const fieldsWithIssues = (await json(r)).issues.map((i: { field: string }) => i.field);
    expect(fieldsWithIssues).toEqual(expect.arrayContaining(['model', 'temperature']));
  });

  it('guardar crea un borrador v2 y lo actualiza; publicar lo pone a evaluar', async () => {
    const admin = await ready('jefe', 'ADMIN');
    let r = await put('/admin/agent/draft', fields(), admin);
    expect(r.status).toBe(200);
    const v2 = await json(r);
    expect(v2).toMatchObject({ version: 2, status: 'DRAFT', agentName: 'Sofía' });

    r = await put('/admin/agent/draft', fields({ agentName: 'Sofía Móvil' }), admin);
    expect((await json(r)).id).toBe(v2.id);
    expect(await db.prisma.agentConfigVersion.count()).toBe(1);

    r = await post('/admin/agent/draft/publish', {}, admin);
    expect(r.status).toBe(201);
    expect(await json(r)).toEqual({ version: 2, status: 'EVALUATING' });
    expect(jobs).toEqual([{ versionId: v2.id, requestedBy: 'jefe' }]);

    // Mientras evalúa no se edita ni se vuelve a publicar.
    expect((await put('/admin/agent/draft', fields(), admin)).status).toBe(409);
    expect((await post('/admin/agent/draft/publish', {}, admin)).status).toBe(409);

    const audit = await db.prisma.adminAuditLog.findMany({
      where: { action: { startsWith: 'AGENT_' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'AGENT_DRAFT_SAVED',
      'AGENT_DRAFT_SAVED',
      'AGENT_PUBLISH_REQUESTED',
    ]);
  });

  it('tras un rechazo, guardar crea una versión nueva (el rechazo queda en el historial)', async () => {
    const admin = await ready('jefe', 'ADMIN');
    await put('/admin/agent/draft', fields(), admin);
    await db.prisma.agentConfigVersion.updateMany({ data: { status: 'REJECTED' } });
    const r = await put('/admin/agent/draft', fields({ agentName: 'Corregido' }), admin);
    expect((await json(r)).version).toBe(3);
    const statuses = (
      await db.prisma.agentConfigVersion.findMany({ orderBy: { version: 'asc' } })
    ).map((v) => v.status);
    expect(statuses).toEqual(['REJECTED', 'DRAFT']);
  });

  it('restaurar copia una versión anterior como borrador', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const old = await db.prisma.agentConfigVersion.create({
      data: { ...fields({ agentName: 'Antigua' }), version: 2, status: 'ARCHIVED', createdBy: 'x' },
    });
    await db.prisma.agentConfigVersion.create({
      data: { ...fields(), version: 3, status: 'PUBLISHED', createdBy: 'x' },
    });
    const r = await post(`/admin/agent/versions/${old.id}/restore`, {}, admin);
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ version: 4, status: 'DRAFT', agentName: 'Antigua' });
    const overview = await json(await call('/admin/agent', {}, admin));
    expect(overview.published.version).toBe(3);
    expect(overview.working.version).toBe(4);
  });

  it('con LLM_PROVIDER=simulado no se puede publicar (regla 13)', async () => {
    const svc = new AgentConfigService(
      db.prisma,
      { provider: 'simulado', defaultModel: null, allowedModels: [] },
      { enqueue: async () => undefined },
    );
    await svc.saveDraft('jefe', fields());
    await expect(svc.publish('jefe')).rejects.toMatchObject({ status: 409 });
    expect((await svc.overview()).canPublish).toBe(false);

    // Proveedor real pero sin API key: tampoco (la suite fallaría por falta de credenciales).
    const noKey = new AgentConfigService(
      db.prisma,
      { provider: 'anthropic', defaultModel: null, allowedModels: [], providerReady: false },
      { enqueue: async () => undefined },
    );
    await expect(noKey.publish('jefe')).rejects.toMatchObject({ status: 409 });
    expect((await noKey.overview()).publishBlocker).toMatch(/API key/);
  });

  it('una evaluación sin respuesta por más del límite se da por rechazada', async () => {
    const svc = new AgentConfigService(
      db.prisma,
      { provider: 'anthropic', defaultModel: null, allowedModels: [], staleEvaluationMs: 0 },
      { enqueue: async () => undefined },
    );
    await svc.saveDraft('jefe', fields());
    await svc.publish('jefe');
    await new Promise((r) => setTimeout(r, 5));
    const o = await svc.overview();
    expect(o.working?.status).toBe('REJECTED');
  });
});

describe('probar agente (chat de simulación)', () => {
  const state = { stage: 'MENU', profile: {}, history: [] };

  it('ADMIN prueba lo que hay en el editor sin guardarlo', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const r = await post(
      '/admin/agent/test',
      { source: 'editor', fields: fields({ agentName: 'Borrador' }), state, message: 'A' },
      admin,
    );
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ stage: 'PERFIL', replies: ['¿Me compartes tu nombre?'] });
    expect(tests[0]).toMatchObject({ message: 'A', agent: { agentName: 'Borrador' } });
    expect(await db.prisma.agentConfigVersion.count()).toBe(0);
  });

  it('el borrador con precios no se puede probar (misma revisión que al guardar)', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const r = await post(
      '/admin/agent/test',
      { source: 'editor', fields: fields({ prompt: 'Plan a $50.000' }), state, message: 'hola' },
      admin,
    );
    expect(r.status).toBe(400);
    expect((await json(r)).issues).toHaveLength(1);
    expect(tests).toHaveLength(0);
  });

  it('OPERADOR siempre prueba la versión publicada, aunque mande un borrador', async () => {
    const ops = await ready('ana.ops', 'OPERADOR');
    await db.prisma.agentConfigVersion.create({
      data: {
        ...fields({ agentName: 'Publicada' }),
        version: 2,
        status: 'PUBLISHED',
        createdBy: 'x',
      },
    });
    const r = await post(
      '/admin/agent/test',
      { source: 'editor', fields: fields({ agentName: 'Intento' }), state, message: 'hola' },
      ops,
    );
    expect(r.status).toBe(201);
    expect(tests[0]!.agent.agentName).toBe('Publicada');
  });

  it('valida el mensaje y el estado', async () => {
    const admin = await ready('jefe', 'ADMIN');
    expect(
      (await post('/admin/agent/test', { source: 'published', state, message: ' ' }, admin)).status,
    ).toBe(400);
    expect(
      (
        await post(
          '/admin/agent/test',
          { source: 'published', state: { stage: 'INVENTADO' }, message: 'hola' },
          admin,
        )
      ).status,
    ).toBe(400);
  });
});
