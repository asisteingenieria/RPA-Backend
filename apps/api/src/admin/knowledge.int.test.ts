import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FieldCipher } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import type { EvalJob } from '@abaya/domain';
import {
  CatalogTableParser,
  createPublishedCatalog,
  ingestSource,
  PgBlobStore,
  publishEvaluatedVersion,
  type KnowledgeIngestJob,
} from '@abaya/knowledge';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AuthController, COOKIE_SECURE } from './auth.controller.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { UsersService } from './users.service.js';

// API de Brains (v1.9, D-001) contra PostgreSQL real. La cola de ingesta se procesa en línea
// (como lo haría el worker) y la evaluación se simula aprobada.

const HEADER =
  'Proceso;ID;Datos;GB para compartir;Incluye;Servicios adicionales;Apps ilimitadas;Llamadas y mensajes;Precio;Descuento';
const CSV = (p1 = '39900') =>
  `${HEADER}\nPortabilidad;P1;10 GB;;Redes;;;;${p1};\nMigración;M1;15 GB;;;;;;45900;\n`;

let db: TestDatabase;
let app: INestApplication;
let base: string;
let users: UsersService;
let blocker: string | null = null;
const evals: EvalJob[] = [];
const cipher = new FieldCipher(randomBytes(32).toString('base64'));

beforeAll(async () => {
  db = await startTestDatabase();
  users = new UsersService(db.prisma);
  const blobs = new PgBlobStore(db.prisma, cipher);
  const knowledge = new KnowledgeService(
    db.prisma,
    blobs,
    {
      ingest: async (job: KnowledgeIngestJob) => {
        await ingestSource({ prisma: db.prisma, blobs, parser: new CatalogTableParser() }, job);
      },
      evaluate: async (job) => void evals.push(job),
    },
    { publishBlocker: () => blocker },
  );
  @Module({
    controllers: [AuthController, KnowledgeController],
    providers: [
      { provide: UsersService, useValue: users },
      { provide: KnowledgeService, useValue: knowledge },
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
  evals.length = 0;
  blocker = null;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON de la API en pruebas
const json = (r: Response) => r.json() as Promise<any>;

const call = (path: string, init: RequestInit = {}, cookie?: string) =>
  fetch(base + path, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      'x-requested-with': 'abaya-panel',
      ...(cookie ? { cookie } : {}),
    },
  });
const post = (path: string, body: unknown, cookie?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body) }, cookie);

function upload(brainId: string, name: string, content: string | Uint8Array, cookie: string) {
  const form = new FormData();
  form.append('use', 'CATALOG');
  form.append('file', new Blob([content]), name);
  return call(`/admin/knowledge/brains/${brainId}/sources`, { method: 'POST', body: form }, cookie);
}

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

async function brainWithPublished(cookie: string) {
  const created = await json(
    await post('/admin/knowledge/brains', { name: 'Catálogo Claro Móvil' }, cookie),
  );
  const r = await upload(created.id, 'planes.csv', CSV(), cookie);
  expect(r.status).toBe(201);
  // Publicación inicial: simula la suite aprobada.
  expect(
    await json(await post(`/admin/knowledge/brains/${created.id}/draft/publish`, {}, cookie)),
  ).toMatchObject({
    version: 1,
    status: 'EVALUATING',
  });
  await publishEvaluatedVersion(db.prisma, {
    versionId: evals[0]!.versionId,
    actor: 'jefe',
    evalSummary: { problems: [] },
  });
  evals.length = 0;
  return created.id as string;
}

describe('Brains: API (v1.9)', () => {
  it('OPERADOR ve y prueba, pero no crea ni carga fuentes (requiere publicarConocimiento)', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const ops = await ready('ana.ops', 'OPERADOR');
    const id = await brainWithPublished(admin);
    expect((await post('/admin/knowledge/brains', { name: 'Otro' }, ops)).status).toBe(403);
    expect((await upload(id, 'x.csv', CSV('1'), ops)).status).toBe(403);
    expect((await post(`/admin/knowledge/brains/${id}/draft/publish`, {}, ops)).status).toBe(403);
    expect((await call('/admin/knowledge/brains', {}, ops)).status).toBe(200);
    const t = await json(
      await post(`/admin/knowledge/brains/${id}/test`, { process: 'PORTABILIDAD' }, ops),
    );
    expect(t).toMatchObject({ version: 1, status: 'OK', process: 'PORTABILIDAD' });
    expect(t.plans.map((p: { code: string }) => p.code)).toEqual(['P1']);
  });

  it('carga: fuente lista con tamaño y estado; borrador con diff; vista previa por proceso', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const id = await brainWithPublished(admin);
    const r = await upload(id, 'planes-octubre.csv', CSV('$ 42.900'), admin);
    expect(r.status).toBe(201);
    const brain = await json(await call(`/admin/knowledge/brains/${id}`, {}, admin));
    expect(brain.sources.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ['planes.csv', 'READY'],
      ['planes-octubre.csv', 'ERROR'], // mismos IDs que la fuente anterior
    ]);
    expect(brain.sources[1].errorReason).toContain('ya está en la fuente «planes.csv»');

    // Reemplazar: quitar la fuente vieja deja el borrador con el precio nuevo.
    const removed = await json(
      await call(
        `/admin/knowledge/brains/${id}/sources/${brain.sources[0].id}`,
        { method: 'DELETE' },
        admin,
      ),
    );
    // Sin fuentes listas, el borrador vaciaría el catálogo (y la suite no lo dejaría publicar).
    expect(removed).toMatchObject({
      draftVersion: 2,
      diff: { removed: [{ code: 'M1' }, { code: 'P1' }] },
    });
    await post(`/admin/knowledge/brains/${id}/sources/${brain.sources[1].id}/reprocess`, {}, admin);
    const after = await json(await call(`/admin/knowledge/brains/${id}`, {}, admin));
    expect(after.sources[0]).toMatchObject({ status: 'READY', sizeBytes: expect.any(Number) });
    const draft = after.versions[0];
    expect(draft).toMatchObject({
      version: 2,
      status: 'DRAFT',
      changes: { added: 0, removed: 0, changed: 1 },
    });

    const diff = await json(await call(`/admin/knowledge/brains/${id}/versions/2/diff`, {}, admin));
    expect(diff.diff.changed[0].changes).toEqual([
      { field: 'priceCop', label: 'Precio', before: 39900, after: 42900 },
    ]);
    const preview = await json(
      await call(`/admin/knowledge/brains/${id}/versions/2?process=MIGRACION`, {}, admin),
    );
    expect(preview.records.map((x: { code: string }) => x.code)).toEqual(['M1']);
  });

  it('valida el tipo real, el tamaño y los duplicados', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const id = (await json(await post('/admin/knowledge/brains', { name: 'B' }, admin))).id;
    const fake = await upload(id, 'planes.xlsx', CSV(), admin);
    expect(fake.status).toBe(400);
    expect((await json(fake)).message).toContain('no es un .xlsx válido');
    expect((await upload(id, 'planes.pdf', '%PDF-1.4', admin)).status).toBe(400);
    expect((await upload(id, 'grande.csv', 'x'.repeat(3 * 1024 * 1024), admin)).status).toBe(413);
    expect((await upload(id, 'a.csv', CSV(), admin)).status).toBe(201);
    const dup = await upload(id, 'copia.csv', CSV(), admin);
    expect(dup.status).toBe(409);
  });

  it('publicar exige borrador con cambios, proveedor real y queda auditado con el diff', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const id = await brainWithPublished(admin);
    expect((await post(`/admin/knowledge/brains/${id}/draft/publish`, {}, admin)).status).toBe(409);
    await db.prisma.knowledgeSource.deleteMany();
    await upload(id, 'nuevo.csv', CSV('42900'), admin);
    blocker = 'Publicar requiere un proveedor de LLM real';
    expect((await post(`/admin/knowledge/brains/${id}/draft/publish`, {}, admin)).status).toBe(409);
    blocker = null;
    const r = await json(await post(`/admin/knowledge/brains/${id}/draft/publish`, {}, admin));
    expect(r).toMatchObject({ version: 2, status: 'EVALUATING' });
    expect(evals).toEqual([expect.objectContaining({ kind: 'brain', requestedBy: 'jefe' })]);
    // Mientras evalúa no se tocan las fuentes.
    expect((await upload(id, 'otro.csv', CSV('1000'), admin)).status).toBe(409);
    const audit = await db.prisma.adminAuditLog.findFirstOrThrow({
      where: { action: 'BRAIN_PUBLISH_REQUESTED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toMatchObject({ actor: 'jefe' });
    expect(JSON.stringify(audit.detail)).toContain('"after":42900');
  });

  it('revertir crea un borrador copia; conectar exige catálogo publicado y uno solo por agente', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const id = await brainWithPublished(admin);
    expect((await post(`/admin/knowledge/brains/${id}/versions/1/restore`, {}, admin)).status).toBe(
      409,
    );

    const put = (b: string) =>
      call(`/admin/knowledge/agents/default/brains/${b}`, { method: 'PUT' }, admin);
    expect((await put(id)).status).toBe(200);
    await createPublishedCatalog(db.prisma, {
      name: 'Otro catálogo',
      records: [
        {
          process: 'LINEA_NUEVA',
          code: 'L1',
          name: null,
          dataText: '1 GB',
          sharedDataText: null,
          includesText: null,
          extrasText: null,
          unlimitedAppsText: null,
          callsText: null,
          priceCop: 1000,
          discountText: null,
        },
      ],
      actor: 'seed',
      action: 'BRAIN_SEEDED',
      note: 'prueba',
    });
    // createPublishedCatalog lo conecta directo: se quita para probar la regla de la API.
    const other = await db.prisma.brain.findUniqueOrThrow({ where: { name: 'Otro catálogo' } });
    await db.prisma.agentBrain.delete({
      where: { agentKey_brainId: { agentKey: 'default', brainId: other.id } },
    });
    const conflict = await put(other.id);
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).message).toContain('un solo catálogo por agente');
    expect((await call(`/admin/knowledge/brains/${id}`, { method: 'DELETE' }, admin)).status).toBe(
      409,
    );
    expect(
      (await call(`/admin/knowledge/agents/default/brains/${id}`, { method: 'DELETE' }, admin))
        .status,
    ).toBe(200);
    expect(
      (await call(`/admin/knowledge/agents/otro/brains/${id}`, { method: 'PUT' }, admin)).status,
    ).toBe(404);
  });

  it('consultar_planes de prueba: proceso sin planes → resultado vacío explícito', async () => {
    const admin = await ready('jefe', 'ADMIN');
    const id = await brainWithPublished(admin);
    const t = await json(
      await post(`/admin/knowledge/brains/${id}/test`, { process: 'LINEA_NUEVA' }, admin),
    );
    expect(t).toEqual({ version: 1, status: 'SIN_PLANES', process: 'LINEA_NUEVA', plans: [] });
    expect(
      (await post(`/admin/knowledge/brains/${id}/test`, { process: 'PREPAGO' }, admin)).status,
    ).toBe(400);
  });
});
