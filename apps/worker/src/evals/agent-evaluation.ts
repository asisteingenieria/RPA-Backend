import { fileURLToPath } from 'node:url';
import type { EvalJob, LlmPort } from '@abaya/domain';
import type { Prisma, PrismaClient } from '@abaya/db';
import type { Logger } from '@abaya/logger';
import { agentConfigFromRow } from '../catalog/agent-config.js';
import { loadAgentCatalog } from '@abaya/knowledge';
import type { TurnKnowledge } from '../engine/conversation-engine.js';
import { gateFailures, loadCases, runSuite, SuiteCancelled, summarize } from './suite.js';

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

/** Resultado de evaluar una versión (D-004). SKIPPED = ya no estaba en evaluación. */
export type AgentEvaluationOutcome = 'OK' | 'WARN' | 'BLOCKED' | 'ERROR' | 'CANCELLED' | 'SKIPPED';

/** Cada cuánto se guarda el avance en la versión (casos). */
const PROGRESS_EVERY = 3;

/**
 * Evalúa una versión del agente con la suite completa (regla 13) y deja el resultado en la
 * versión como evidencia, sin cambiar su estado (D-005: puede estar ya publicada): OK (0 inventados
 * y ≥ 95 %), WARN (0 inventados pero bajo la meta), BLOCKED (inventó datos) o ERROR (no se pudo
 * evaluar). Si la evaluación deja de estar en curso (RUNNING: se canceló porque se guardó otro
 * borrador), la suite se detiene y no escribe nada.
 */
export async function evaluateAgentVersion(
  d: AgentEvaluationDeps,
  job: EvalJob,
): Promise<AgentEvaluationOutcome> {
  const row = await d.prisma.agentConfigVersion.findUnique({ where: { id: job.versionId } });
  if (!row || row.evalVerdict !== 'RUNNING') return 'SKIPPED';
  const agent = agentConfigFromRow(row);
  const startedAt = new Date();
  const stillEvaluating = async () =>
    (await d.prisma.agentConfigVersion.count({ where: { id: row.id, evalVerdict: 'RUNNING' } })) >
    0;

  /** Escribe el resultado solo si la evaluación sigue en curso (no pisa una cancelación). */
  const finish = async (
    verdict: Exclude<AgentEvaluationOutcome, 'SKIPPED' | 'CANCELLED'>,
    problems: string[],
    extra: Record<string, unknown> = {},
  ): Promise<AgentEvaluationOutcome> => {
    const summary = {
      provider: d.provider,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      verdict,
      problems,
      ...extra,
    };
    const done = await d.prisma.$transaction(async (tx) => {
      const r = await tx.agentConfigVersion.updateMany({
        where: { id: row.id, evalVerdict: 'RUNNING' },
        data: {
          evalVerdict: verdict,
          evaluatedAt: new Date(),
          evalSummary: summary as Prisma.InputJsonValue,
        },
      });
      if (!r.count) return false;
      await tx.adminAuditLog.create({
        data: {
          actor: job.requestedBy,
          action: 'AGENT_EVALUATED',
          target: `v${row.version}`,
          detail: { verdict, problems } as Prisma.InputJsonValue,
        },
      });
      return true;
    });
    if (!done) return 'CANCELLED';
    d.logger.info({ version: row.version, verdict, problems }, 'versión del agente evaluada');
    return verdict;
  };

  if (d.provider === 'simulado') {
    return finish('ERROR', [
      'requiere un proveedor de LLM real (LLM_PROVIDER=simulado no sirve para evaluar el guion)',
    ]);
  }

  let results;
  try {
    // El agente se evalúa con el catálogo PUBLICADO que va a usar (v1.9).
    const catalog = await loadAgentCatalog(d.prisma);
    if (!catalog) return finish('ERROR', ['no hay un catálogo publicado conectado al agente']);
    const cases = loadCases(d.casesDir ?? DEFAULT_CASES_DIR);
    results = await runSuite(cases, {
      provider: d.provider,
      llm: d.llm,
      plans: catalog.records,
      agent,
      ...(d.knowledge ? { knowledge: d.knowledge } : {}),
      shouldContinue: stillEvaluating,
      onProgress: async (done, total) => {
        if (done % PROGRESS_EVERY && done !== total && done !== 0) return;
        await d.prisma.agentConfigVersion.updateMany({
          where: { id: row.id, evalVerdict: 'RUNNING' },
          data: {
            evalSummary: {
              startedAt: startedAt.toISOString(),
              progress: { done, total },
            } as Prisma.InputJsonValue,
          },
        });
      },
    });
  } catch (err) {
    if (err instanceof SuiteCancelled) {
      d.logger.info({ version: row.version }, 'evaluación cancelada');
      return 'CANCELLED';
    }
    return finish('ERROR', [
      `la evaluación no pudo completarse (${err instanceof Error ? err.name : 'error'})`,
    ]);
  }

  const s = summarize(results, d.provider);
  const problems = gateFailures(s);
  const verdict = s.invented > 0 ? 'BLOCKED' : problems.length ? 'WARN' : 'OK';
  return finish(verdict, problems, {
    model: agent.model,
    cases: s.cases,
    passed: s.passed,
    invented: s.invented,
    regenRate: s.regenRate,
    fallbackRate: s.fallbackRate,
    p50: s.p50,
    p95: s.p95,
    // Casos guionados (sintéticos, sin datos de clientes): motivos y la conversación de cada falla.
    failedCases: results
      .filter((r) => !r.passed)
      .slice(0, 30)
      .map((r) => ({
        id: r.id,
        group: r.group,
        failures: r.failures.slice(0, 5),
        transcript: r.transcript.slice(0, 40),
      })),
  });
}
