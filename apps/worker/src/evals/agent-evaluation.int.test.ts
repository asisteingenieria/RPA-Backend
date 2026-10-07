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
    data: { ...v1, version: 2, prompt, status: 'EVALUATING', createdBy: 'jefe' },
  });
}

describe('publicar una versión del agente = pasar la suite (regla 13)', () => {
  it('si cumple la meta se publica y la anterior queda archivada; el motor usa su guion', async () => {
    const v2 = await evaluating();
    const requests: LlmRequest[] = [];
    const outcome = await evaluateAgentVersion(
      {
        prisma: db.prisma,
        provider: 'anthropic',
        llm: () =>
          new ScriptedLlmAdapter((req) => {
            requests.push(req);
            return heuristicBrain(req);
          }),
        logger,
      },
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    expect(outcome).toBe('PUBLISHED');
    const [old, current] = await versions();
    expect(old!.status).toBe('ARCHIVED');
    expect(current).toMatchObject({ status: 'PUBLISHED', publishedBy: 'jefe' });
    expect(current!.evalSummary).toMatchObject({ cases: 66, invented: 0, problems: [] });
    // El guion de la versión evaluada va detrás de las reglas del sistema.
    expect(requests[0]!.systemFixed.startsWith(SYSTEM_RULES)).toBe(true);
    expect(requests[0]!.systemFixed).toContain('Eres Sofía, guion de prueba.');
    expect(requests[0]!.systemDynamic).toMatch(/Etapa actual: [A-Z]+/);

    const audit = await db.prisma.adminAuditLog.findMany({
      where: { action: { startsWith: 'AGENT_' } },
    });
    expect(audit.map((a) => a.action)).toEqual(['AGENT_PUBLISHED']);

    // El worker toma la versión publicada.
    const source = new PrismaAgentConfigSource(db.prisma, logger);
    await source.refresh();
    expect(source.get()).toMatchObject({ id: v2.id, version: 2 });
  }, 60_000);

  it('si no cumple la meta se rechaza con el motivo y la publicada no cambia', async () => {
    const v2 = await evaluating();
    // Un modelo que siempre intenta poner un precio: los validadores lo frenan (respuesta
    // segura), así que no hay datos inventados, pero los casos no llegan a su resultado.
    const outcome = await evaluateAgentVersion(
      {
        prisma: db.prisma,
        provider: 'anthropic',
        llm: () =>
          new ScriptedLlmAdapter((req) => ({
            ...heuristicBrain(req),
            reply: 'Te lo dejo en $30.000',
          })),
        logger,
      },
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    expect(outcome).toBe('REJECTED');
    const [published, rejected] = await versions();
    expect(published!.status).toBe('PUBLISHED');
    expect(rejected!.status).toBe('REJECTED');
    const summary = rejected!.evalSummary as { problems: string[]; invented: number };
    expect(summary.invented).toBe(0);
    expect(summary.problems.join(' ')).toMatch(/correctos \(meta ≥ 95 %\)/);
  }, 60_000);

  it('con el proveedor simulado se rechaza sin correr la suite', async () => {
    const v2 = await evaluating();
    let called = false;
    const outcome = await evaluateAgentVersion(
      {
        prisma: db.prisma,
        provider: 'simulado',
        llm: () => {
          called = true;
          return new ScriptedLlmAdapter(heuristicBrain);
        },
        logger,
      },
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    expect(outcome).toBe('REJECTED');
    expect(called).toBe(false);
  });

  it('una versión que ya no está en evaluación se ignora', async () => {
    const v2 = await evaluating();
    await db.prisma.agentConfigVersion.update({ where: { id: v2.id }, data: { status: 'DRAFT' } });
    const outcome = await evaluateAgentVersion(
      {
        prisma: db.prisma,
        provider: 'anthropic',
        llm: () => new ScriptedLlmAdapter(heuristicBrain),
        logger,
      },
      { versionId: v2.id, requestedBy: 'jefe' },
    );
    expect(outcome).toBe('SKIPPED');
  });
});
