import { fileURLToPath } from 'node:url';
import type { EvalJob, LlmPort } from '@abaya/domain';
import { withSerializableRetry, type Prisma, type PrismaClient } from '@abaya/db';
import type { Logger } from '@abaya/logger';
import { agentConfigFromRow } from '../catalog/agent-config.js';
import { loadAgentCatalog } from '@abaya/knowledge';
import type { TurnKnowledge } from '../engine/conversation-engine.js';
import { gateFailures, loadCases, runSuite, summarize } from './suite.js';

export const DEFAULT_CASES_DIR = fileURLToPath(
  new URL('../../../../evals/conversations', import.meta.url),
);

export interface AgentEvaluationDeps {
  prisma: PrismaClient;
  /** `LLM_PROVIDER` del worker: con `simulado` no se puede publicar (regla 13). */
  provider: string;
  /** Proveedor principal, sin respaldo: se evalúa el modelo que va a responder. */
  llm: () => LlmPort;
  casesDir?: string;
  logger: Logger;
  /** v1.9: documentos de los Brains publicados del agente. */
  knowledge?: TurnKnowledge;
}

export type AgentEvaluationOutcome = 'PUBLISHED' | 'REJECTED' | 'SKIPPED';

/**
 * Evalúa un borrador del agente con la suite completa (v1.8, sección 6.3.8) y lo publica
 * solo si cumple la meta (0 inventados, ≥ 95 %). Al publicar, la versión anterior queda
 * ARCHIVED en la misma transacción: nunca hay dos publicadas.
 */
export async function evaluateAgentVersion(
  d: AgentEvaluationDeps,
  job: EvalJob,
): Promise<AgentEvaluationOutcome> {
  const row = await d.prisma.agentConfigVersion.findUnique({ where: { id: job.versionId } });
  if (!row || row.status !== 'EVALUATING') return 'SKIPPED';
  const agent = agentConfigFromRow(row);
  const startedAt = new Date();

  const reject = async (problems: string[], extra: Record<string, unknown> = {}) => {
    const summary = {
      provider: d.provider,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      problems,
      ...extra,
    };
    await d.prisma.$transaction([
      d.prisma.agentConfigVersion.update({
        where: { id: row.id },
        data: { status: 'REJECTED', evalSummary: summary as Prisma.InputJsonValue },
      }),
      d.prisma.adminAuditLog.create({
        data: { actor: job.requestedBy, action: 'AGENT_REJECTED', target: `v${row.version}` },
      }),
    ]);
    d.logger.warn({ version: row.version, problems }, 'versión del agente rechazada');
    return 'REJECTED' as const;
  };

  if (d.provider === 'simulado') {
    return reject([
      'requiere un proveedor de LLM real (LLM_PROVIDER=simulado no sirve para evaluar el guion)',
    ]);
  }

  let results;
  let plans;
  try {
    // El agente se evalúa con el catálogo PUBLICADO que va a usar (v1.9).
    const catalog = await loadAgentCatalog(d.prisma);
    if (!catalog) return reject(['no hay un catálogo publicado conectado al agente']);
    plans = catalog.records;
    const cases = loadCases(d.casesDir ?? DEFAULT_CASES_DIR);
    results = await runSuite(cases, {
      provider: d.provider,
      llm: d.llm,
      plans,
      agent,
      ...(d.knowledge ? { knowledge: d.knowledge } : {}),
    });
  } catch (err) {
    return reject([
      `la evaluación no pudo completarse (${err instanceof Error ? err.name : 'error'})`,
    ]);
  }

  const s = summarize(results, d.provider);
  const problems = gateFailures(s);
  const extra = {
    model: agent.model,
    cases: s.cases,
    passed: s.passed,
    invented: s.invented,
    regenRate: s.regenRate,
    fallbackRate: s.fallbackRate,
    p50: s.p50,
    p95: s.p95,
    // Solo ids y motivos: los casos son guionados (sintéticos), sin datos de clientes.
    failedCases: results
      .filter((r) => !r.passed)
      .slice(0, 30)
      .map((r) => ({ id: r.id, failures: r.failures.slice(0, 5) })),
  };
  if (problems.length) return reject(problems, extra);

  const summary = {
    provider: d.provider,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    problems: [],
    ...extra,
  };
  const published = await withSerializableRetry(() =>
    d.prisma.$transaction(
      async (tx) => {
        const current = await tx.agentConfigVersion.findUnique({ where: { id: row.id } });
        if (current?.status !== 'EVALUATING') return false;
        await tx.agentConfigVersion.updateMany({
          where: { status: 'PUBLISHED' },
          data: { status: 'ARCHIVED' },
        });
        await tx.agentConfigVersion.update({
          where: { id: row.id },
          data: {
            status: 'PUBLISHED',
            evalSummary: summary as Prisma.InputJsonValue,
            publishedBy: job.requestedBy,
            publishedAt: new Date(),
          },
        });
        await tx.adminAuditLog.create({
          data: { actor: job.requestedBy, action: 'AGENT_PUBLISHED', target: `v${row.version}` },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    ),
  );
  if (!published) return 'SKIPPED';
  d.logger.info({ version: row.version }, 'versión del agente publicada');
  return 'PUBLISHED';
}
