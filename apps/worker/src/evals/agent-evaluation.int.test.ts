import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { DEFAULT_AGENT_CONFIG, SYSTEM_RULES, type LlmRequest } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublishedCatalog, DEFAULT_CATALOG_BRAIN } from '@abaya/knowledge';
import { readCatalogFile, SYNTHETIC_CATALOG } from '../catalog/catalog.js';
import { PrismaAgentConfigSource } from '../catalog/agent-config.js';
import { heuristicBrain } from '../llm/adapters/heuristic-brain.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';
import { evaluateAgentVersion } from './agent-evaluation.js';

let db: TestDatabase;
const logger = createLogger('test', { level: 'silent' });
const plans = await readCatalogFile(SYNTHETIC_CATALOG);

beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  // Catálogo sintético publicado como v1 del Brain conectado al agente (v1.9).
  await createPublishedCatalog(db.prisma, {
    name: DEFAULT_CATALOG_BRAIN,
    records: plans,
    actor: 'seed',
    action: 'BRAIN_SEEDED',
    note: 'prueba',
  });
});

const { id: _id, ...v1 } = DEFAULT_AGENT_CONFIG;

async function versions() {
  return db.prisma.agentConfigVersion.findMany({ orderBy: { version: 'asc' } });
}

async function evaluating(prompt = '# Rol\n- Eres Sofía, guion de prueba.') {
  await db.prisma.agentConfigVersion.create({
    data: { ...v1, status: 'PUBLISHED', createdBy: 'seed' },
  });
  return db.prisma.agentConfigVersion.create({
    data: { ...v1, version: 2, prompt, status: 'DRAFT', evalVerdict: 'RUNNING', createdBy: 'jefe' },
  });
}

const deps = (llm: () => ScriptedLlmAdapter, provider = 'anthropic') => ({
  prisma: db.prisma,
  provider,
  llm,
  logger,
});

describe('evaluar una versión del agente (regla 13; D-004/D-005: evaluar no publica ni despublica)', () => {
  it('si cumple la meta queda OK, sin publicar; el motor usa su guion y se ve el avance', async () => {
    const v2 = await evaluating();
    const requests: LlmRequest[] = [];
    const progress: unknown[] = [];
    const tick = setInterval(() => {
      void db.prisma.agentConfigVersion
        .findUnique({ where: { id: v2.id } })
        .then((r) => r?.evalVerdict === 'RUNNING' && progress.push(r.evalSummary));
    }, 50);
    const outcome = await evaluateAgentVersion(
      deps(
        () =>
          new ScriptedLlmAdapter((req) => {
            requests.push(req);
            return heuristicBrain(req);
          }),
      ),
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    clearInterval(tick);
    expect(outcome).toBe('OK');
    const [published, evaluated] = await versions();
    // Evaluar no publica: la v1 sigue publicada y la v2 queda lista para publicar.
    expect(published!.status).toBe('PUBLISHED');
    expect(evaluated).toMatchObject({ status: 'DRAFT', evalVerdict: 'OK', publishedBy: null });
    expect(evaluated!.evaluatedAt).not.toBeNull();
    expect(evaluated!.evalSummary).toMatchObject({
      verdict: 'OK',
      cases: 69,
      invented: 0,
      problems: [],
    });
    expect(
      progress.some((p) => (p as { progress?: { total: number } }).progress?.total === 69),
    ).toBe(true);
    // El guion de la versión evaluada va detrás de las reglas del sistema.
    expect(requests[0]!.systemFixed.startsWith(SYSTEM_RULES)).toBe(true);
    expect(requests[0]!.systemFixed).toContain('Eres Sofía, guion de prueba.');
    expect(requests[0]!.systemDynamic).toMatch(/Etapa actual: [A-Z]+/);

    const audit = await db.prisma.adminAuditLog.findMany({
      where: { action: { startsWith: 'AGENT_' } },
    });
    expect(audit.map((a) => a.action)).toEqual(['AGENT_EVALUATED']);
    expect(audit[0]!.detail).toMatchObject({ verdict: 'OK' });

    // El worker sigue con la versión publicada (la v1).
    const source = new PrismaAgentConfigSource(db.prisma, logger);
    await source.refresh();
    expect(source.get().version).toBe(1);
  }, 60_000);

  it('bajo la meta sin datos inventados queda con alertas (WARN) y los casos fallidos', async () => {
    const v2 = await evaluating();
    // Un modelo que siempre intenta poner un precio: los validadores lo frenan (respuesta
    // segura), así que no hay datos inventados, pero los casos no llegan a su resultado.
    const outcome = await evaluateAgentVersion(
      deps(
        () =>
          new ScriptedLlmAdapter((req) => ({
            ...heuristicBrain(req),
            reply: 'Te lo dejo en $30.000',
          })),
      ),
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    expect(outcome).toBe('WARN');
    const [published, warned] = await versions();
    expect(published!.status).toBe('PUBLISHED');
    expect(warned).toMatchObject({ status: 'DRAFT', evalVerdict: 'WARN' });
    const summary = warned!.evalSummary as {
      problems: string[];
      invented: number;
      failedCases: { id: string; transcript: unknown[] }[];
    };
    expect(summary.invented).toBe(0);
    expect(summary.problems.join(' ')).toMatch(/correctos \(meta ≥ 95 %\)/);
    expect(summary.failedCases[0]!.transcript.length).toBeGreaterThan(0);
  }, 60_000);

  it('con el proveedor simulado queda en error sin correr la suite', async () => {
    const v2 = await evaluating();
    let called = false;
    const outcome = await evaluateAgentVersion(
      deps(() => {
        called = true;
        return new ScriptedLlmAdapter(heuristicBrain);
      }, 'simulado'),
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    expect(outcome).toBe('ERROR');
    expect(called).toBe(false);
    expect((await versions())[1]).toMatchObject({ status: 'DRAFT', evalVerdict: 'ERROR' });
  });

  it('si la cancelan a mitad (se guardó otra versión) se detiene y no pisa la cancelación', async () => {
    const v2 = await evaluating();
    let calls = 0;
    let cancel: Promise<unknown> | undefined;
    const outcome = await evaluateAgentVersion(
      deps(
        () =>
          new ScriptedLlmAdapter((req) => {
            // A mitad de la suite el panel guarda otra versión: la API marca esta como cancelada.
            // (Las consultas de Prisma son perezosas: `.then` las ejecuta.)
            if (++calls === 5) {
              cancel = db.prisma.agentConfigVersion
                .update({
                  where: { id: v2.id },
                  data: { evalVerdict: 'CANCELLED' },
                })
                .then(() => undefined);
            }
            return heuristicBrain(req);
          }),
      ),
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    await cancel;
    expect(outcome).toBe('CANCELLED');
    expect((await versions())[1]).toMatchObject({ status: 'DRAFT', evalVerdict: 'CANCELLED' });
    expect(await db.prisma.adminAuditLog.count({ where: { action: 'AGENT_EVALUATED' } })).toBe(0);
  }, 60_000);

  it('una versión que ya no está en evaluación se ignora', async () => {
    const v2 = await evaluating();
    await db.prisma.agentConfigVersion.update({ where: { id: v2.id }, data: { evalVerdict: null } });
    const outcome = await evaluateAgentVersion(
      deps(() => new ScriptedLlmAdapter(heuristicBrain)),
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    expect(outcome).toBe('SKIPPED');
  });
});

it('D-005: una versión ya publicada se evalúa y sigue publicada (el resultado es evidencia)', async () => {
  const v2 = await evaluating();
  await db.prisma.agentConfigVersion.updateMany({
    where: { status: 'PUBLISHED' },
    data: { status: 'ARCHIVED' },
  });
  await db.prisma.agentConfigVersion.update({
    where: { id: v2.id },
    data: { status: 'PUBLISHED' },
  });
  const outcome = await evaluateAgentVersion(
    deps(
      () =>
        new ScriptedLlmAdapter((req) => ({
          ...heuristicBrain(req),
          reply: 'Te lo dejo en $30.000',
        })),
    ),
    { versionId: v2.id, requestedBy: 'jefe' },
  );
  expect(outcome).toBe('WARN');
  expect((await versions())[1]).toMatchObject({ status: 'PUBLISHED', evalVerdict: 'WARN' });
}, 60_000);

describe('versión del agente por conversación (D-004)', () => {
  it('resolve: la publicada, una anterior ya publicada o la v1; nunca un borrador', async () => {
    const v2 = await evaluating();
    const [v1row] = await versions();
    const draft = await db.prisma.agentConfigVersion.create({
      data: { ...v1, version: 3, status: 'DRAFT', createdBy: 'jefe' },
    });
    await db.prisma.agentConfigVersion.update({
      where: { id: v1row!.id },
      data: { status: 'ARCHIVED' },
    });
    await db.prisma.agentConfigVersion.update({
      where: { id: v2.id },
      data: { status: 'PUBLISHED' },
    });
    const source = new PrismaAgentConfigSource(db.prisma, logger);
    await source.refresh();
    expect((await source.resolve(undefined)).id).toBe(v2.id);
    expect((await source.resolve(v1row!.id)).id).toBe(v1row!.id); // archivada: sigue atendiendo
    expect((await source.resolve(DEFAULT_AGENT_CONFIG.id)).id).toBe(DEFAULT_AGENT_CONFIG.id);
    expect((await source.resolve(draft.id)).id).toBe(v2.id); // un borrador nunca atiende
    expect((await source.resolve('no-existe')).id).toBe(v2.id);
  });
});
