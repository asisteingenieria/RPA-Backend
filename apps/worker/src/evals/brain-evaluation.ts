import { DEFAULT_AGENT_CONFIG, type EvalJob, type LlmPort } from '@abaya/domain';
import type { PrismaClient } from '@abaya/db';
import {
  diffCatalogs,
  isEmptyDiff,
  publishEvaluatedVersion,
  rebuildDraftFromSources,
  recordsFromSources,
  rejectEvaluatedVersion,
  versionRecords,
} from '@abaya/knowledge';
import type { Logger } from '@abaya/logger';
import { agentConfigFromRow } from '../catalog/agent-config.js';
import { DEFAULT_CASES_DIR, type AgentEvaluationOutcome } from './agent-evaluation.js';
import { gateFailures, loadCases, runSuite, summarize } from './suite.js';

export interface BrainEvaluationDeps {
  prisma: PrismaClient;
  provider: string;
  llm: () => LlmPort;
  casesDir?: string;
  logger: Logger;
}

/**
 * Publicar una versión del catálogo de un Brain = pasar la suite de evaluación (regla 13,
 * D-001 D3) con el agente PUBLICADO y el catálogo del borrador. Solo publica con 0 datos
 * inventados y ≥ 95 % de casos correctos; si no, queda REJECTED con el reporte.
 */
export async function evaluateBrainVersion(
  d: BrainEvaluationDeps,
  job: EvalJob,
): Promise<AgentEvaluationOutcome> {
  const version = await d.prisma.brainVersion.findUnique({ where: { id: job.versionId } });
  if (!version || version.status !== 'EVALUATING') return 'SKIPPED';
  const startedAt = new Date();
  const base = { provider: d.provider, startedAt: startedAt.toISOString() };

  const reject = async (problems: string[], extra: Record<string, unknown> = {}) => {
    await rejectEvaluatedVersion(d.prisma, {
      versionId: version.id,
      actor: job.requestedBy,
      evalSummary: { ...base, finishedAt: new Date().toISOString(), problems, ...extra },
    });
    d.logger.warn(
      { brainId: version.brainId, version: version.version, problems },
      'catálogo rechazado',
    );
    return 'REJECTED' as const;
  };

  if (d.provider === 'simulado') {
    return reject([
      'requiere un proveedor de LLM real (LLM_PROVIDER=simulado no sirve para evaluar el catálogo)',
    ]);
  }

  let results;
  let agentVersion: number;
  try {
    const records = await versionRecords(d.prisma, version.id);
    const row = await d.prisma.agentConfigVersion.findFirst({
      where: { status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
    });
    const agent = row ? agentConfigFromRow(row) : DEFAULT_AGENT_CONFIG;
    agentVersion = agent.version;
    const cases = loadCases(d.casesDir ?? DEFAULT_CASES_DIR);
    results = await runSuite(cases, { provider: d.provider, llm: d.llm, plans: records, agent });
  } catch (err) {
    return reject([
      `la evaluación no pudo completarse (${err instanceof Error ? err.name : 'error'})`,
    ]);
  }

  const s = summarize(results, d.provider);
  const problems = gateFailures(s);
  const extra = {
    agentVersion,
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

  const published = await publishEvaluatedVersion(d.prisma, {
    versionId: version.id,
    actor: job.requestedBy,
    evalSummary: { ...base, finishedAt: new Date().toISOString(), problems: [], ...extra },
  });
  if (!published) return 'SKIPPED';
  d.logger.info({ brainId: version.brainId, version: version.version }, 'catálogo publicado');
  return 'PUBLISHED';
}

/**
 * Si las fuentes cambiaron mientras se evaluaba (la ingesta no toca una versión en
 * evaluación), se rearma el borrador al terminar.
 */
export async function catchUpDraft(
  prisma: PrismaClient,
  versionId: string,
  evaluationStartedAt: Date,
): Promise<void> {
  const v = await prisma.brainVersion.findUnique({
    where: { id: versionId },
    include: { brain: { select: { sourcesChangedAt: true } } },
  });
  if (!v || v.status === 'EVALUATING') return;
  const changed = v.brain.sourcesChangedAt;
  if (!changed || changed <= evaluationStartedAt) return;
  const [fromSources, evaluated] = await Promise.all([
    recordsFromSources(prisma, v.brainId),
    versionRecords(prisma, v.id),
  ]);
  if (!isEmptyDiff(diffCatalogs(evaluated, fromSources))) {
    await rebuildDraftFromSources(prisma, v.brainId, 'sistema');
  }
}
