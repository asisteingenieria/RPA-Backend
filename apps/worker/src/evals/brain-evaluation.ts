import { DEFAULT_AGENT_CONFIG, type EvalJob, type LlmPort } from '@abaya/domain';
import type { PrismaClient } from '@abaya/db';
import {
  agentPublishedVersions,
  contentFromSources,
  diffContent,
  isEmptyBrainDiff,
  loadAgentCatalog,
  publishEvaluatedVersion,
  rebuildDraftFromSources,
  rejectEvaluatedVersion,
  versionContent,
  versionRecords,
  type KnowledgeRetriever,
} from '@abaya/knowledge';
import type { Logger } from '@abaya/logger';
import { agentConfigFromRow } from '../catalog/agent-config.js';
import { FixedKnowledge } from '../knowledge/published-knowledge.js';
import { DEFAULT_CASES_DIR } from './agent-evaluation.js';

/** Los Brains siguen publicando al pasar la suite (v1.9). */
export type BrainEvaluationOutcome = 'PUBLISHED' | 'REJECTED' | 'SKIPPED';
import { gateFailures, loadCases, runSuite, summarize } from './suite.js';

export interface BrainEvaluationDeps {
  prisma: PrismaClient;
  provider: string;
  llm: () => LlmPort;
  casesDir?: string;
  logger: Logger;
  /** v1.9 K3/K4: para que la suite vea los documentos del borrador. */
  retriever?: KnowledgeRetriever;
}

/**
 * Publicar una versión de un Brain = pasar la suite de evaluación (regla 13, D-001 D3) con el
 * agente PUBLICADO y lo que va a usar si se publica: el catálogo del borrador (o el publicado,
 * si el Brain no es de catálogo) y los documentos de los Brains conectados, con los del borrador
 * en lugar de los publicados de ese Brain. Solo publica con 0 datos inventados y ≥ 95 %.
 */
export async function evaluateBrainVersion(
  d: BrainEvaluationDeps,
  job: EvalJob,
): Promise<BrainEvaluationOutcome> {
  const version = await d.prisma.brainVersion.findUnique({
    where: { id: job.versionId },
    include: { brain: { select: { name: true } } },
  });
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
      'Brain rechazado',
    );
    return 'REJECTED' as const;
  };

  if (d.provider === 'simulado') {
    return reject([
      'requiere un proveedor de LLM real (LLM_PROVIDER=simulado no sirve para evaluar el Brain)',
    ]);
  }

  let results;
  let agentVersion: number;
  try {
    let plans = await versionRecords(d.prisma, version.id);
    if (!plans.length) {
      // Brain sin catálogo (solo documentos): la suite usa el catálogo publicado del agente.
      const catalog = await loadAgentCatalog(d.prisma);
      if (!catalog) return reject(['no hay un catálogo publicado conectado al agente']);
      plans = catalog.records;
    }
    const row = await d.prisma.agentConfigVersion.findFirst({
      where: { status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
    });
    const agent = row ? agentConfigFromRow(row) : DEFAULT_AGENT_CONFIG;
    agentVersion = agent.version;
    const versions = [
      ...(await agentPublishedVersions(d.prisma)).filter((v) => v.brainId !== version.brainId),
      {
        brainId: version.brainId,
        brainName: version.brain.name,
        versionId: version.id,
        version: version.version,
      },
    ];
    const cases = loadCases(d.casesDir ?? DEFAULT_CASES_DIR);
    results = await runSuite(cases, {
      provider: d.provider,
      llm: d.llm,
      plans,
      agent,
      ...(d.retriever ? { knowledge: new FixedKnowledge(d.retriever, versions) } : {}),
    });
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
  d.logger.info({ brainId: version.brainId, version: version.version }, 'Brain publicado');
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
    contentFromSources(prisma, v.brainId),
    versionContent(prisma, v.id),
  ]);
  if (!isEmptyBrainDiff(diffContent(evaluated, fromSources))) {
    await rebuildDraftFromSources(prisma, v.brainId, 'sistema');
  }
}
