import { Prisma, withSerializableRetry, type PrismaClient } from '@abaya/db';
import {
  AGENT_LIMITS,
  AGENT_PROMPT_STAGES,
  DEFAULT_AGENT_CONFIG,
  MENU_OPTIONS,
  STAGES,
  SYSTEM_RULES,
  reviewAgentConfig,
  type AgentConfig,
  type AgentConfigInput,
  type AgentReviewIssue,
  type AgentTestJob,
  type AgentTestResult,
  type EvalJob,
  type Stage,
} from '@abaya/domain';
import { ServiceError } from './errors.js';

/** Encola la evaluación de una versión (el worker la corre y deja su resultado; D-004). */
export interface EvalQueuePort {
  enqueue(job: EvalJob): Promise<void>;
}

/** Corre un turno simulado en el worker y espera la respuesta ("Probar agente"). */
export interface AgentTestPort {
  run(job: AgentTestJob): Promise<AgentTestResult>;
}

const PROFILE_KEYS = new Set([
  'process',
  'name',
  'currentOperator',
  'usage',
  'planCode',
  'offeredPlanCode',
  'authorizationShownAt',
  'authorizationTemplateVersion',
  'authorizationTextHash',
]);
/** Marcas del flujo que la simulación conserva entre turnos (D-003). */
const PROFILE_FLAGS = new Set(['authorizationDeclined', 'supportRedirected']);
const MAX_TEST_TEXT = 2_000;

/** Resultado de la evaluación de una versión (D-004). */
/** D-005: RUNNING = la suite está corriendo (la evaluación ya no es un estado de la versión). */
export type EvalVerdict = 'OK' | 'WARN' | 'BLOCKED' | 'ERROR' | 'CANCELLED' | 'RUNNING';
/** Motivo mínimo para publicar una versión con alertas. */
/** Conversaciones que siguen abiertas (la publicación urgente las pasa a la versión nueva). */
const OPEN_CONVERSATION_STATUSES = [
  'ACTIVE',
  'WAITING_CONSENT',
  'TRANSFERRING',
  'NEEDS_REVIEW',
] as const;
const TEST_ROLES = new Set(['customer', 'bot', 'event']);
const MAX_TEST_LINES = 200;

export interface AgentConfigOptions {
  /** `LLM_PROVIDER`: con `simulado` no se puede publicar (regla 13). */
  provider: string;
  /** `LLM_MODEL` (null = el por defecto del adaptador). */
  defaultModel: string | null;
  /** `LLM_ALLOWED_MODELS`. */
  allowedModels: string[];
  /** false si el proveedor no tiene API key configurada (no se podría evaluar). */
  providerReady?: boolean;
  /** Una evaluación sin respuesta en este tiempo se da por fallida (worker caído). */
  staleEvaluationMs?: number;
}

/** Revisión fallida: el controlador la devuelve como 400 con la lista de problemas. */
export class AgentReviewError extends Error {
  constructor(readonly issues: AgentReviewIssue[]) {
    super('La configuración no pasó la revisión');
  }
}

const VERSION_SELECT = {
  id: true,
  version: true,
  status: true,
  agentName: true,
  model: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  publishedBy: true,
  publishedAt: true,
  evalSummary: true,
  evalVerdict: true,
  evaluatedAt: true,
  changeNote: true,
  publishReason: true,
  appliedToOpen: true,
} as const;

const CONTENT_SELECT = {
  ...VERSION_SELECT,
  companyName: true,
  companyInfo: true,
  welcome: true,
  prompt: true,
  temperature: true,
} as const;

/**
 * Configuración del agente en el panel (v1.8, sección 6.3.8; D-004 y D-005): guardar, publicar al
 * instante e historial con notas, pruebas y evaluaciones. El contenido se revisa al guardar
 * (regla 11) y cada respuesta del robot pasa por los validadores (regla 10).
 *
 * D-005: publicar NO depende de la evaluación. La suite corre en segundo plano después de publicar
 * (o cuando se pide) y su resultado queda como evidencia en el historial de la versión. Una versión
 * evaluada no cambia más: guardar después crea otra.
 */
export class AgentConfigService {
  private readonly staleMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: AgentConfigOptions,
    private readonly queue: EvalQueuePort,
    private readonly tester?: AgentTestPort,
    /** v1.9: catálogo publicado del Brain conectado al agente (solo lectura en el panel). */
    private readonly catalog?: () => Promise<unknown[]>,
  ) {
    this.staleMs = opts.staleEvaluationMs ?? 30 * 60_000;
  }

  /** Modelos que se pueden elegir (el principal siempre está). */
  models(): string[] {
    return [
      ...new Set([
        ...(this.opts.defaultModel ? [this.opts.defaultModel] : []),
        ...this.opts.allowedModels,
      ]),
    ];
  }

  async overview() {
    await this.expireStale();
    const [published, working, catalog] = await Promise.all([
      this.prisma.agentConfigVersion.findFirst({
        where: { status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
        select: CONTENT_SELECT,
      }),
      this.working(),
      this.catalog ? this.catalog() : Promise.resolve([]),
    ]);
    return {
      published: published ?? { ...DEFAULT_AGENT_CONFIG, status: 'PUBLISHED', builtIn: true },
      working,
      systemRules: SYSTEM_RULES,
      menuOptions: MENU_OPTIONS,
      stages: AGENT_PROMPT_STAGES,
      limits: AGENT_LIMITS,
      provider: this.opts.provider,
      // D-005: publicar siempre se puede (el rol lo controla el guard); evaluar puede no estar disponible.
      canPublish: true,
      publishBlocker: null,
      canEvaluate: this.publishBlocker() === null,
      evaluateBlocker: this.publishBlocker(),
      temperatureApplies: this.opts.provider !== 'anthropic',
      defaultModel: this.opts.defaultModel,
      models: this.models(),
      catalog,
    };
  }

  /** Revisión sin guardar (el panel la usa mientras se escribe). */
  review(body: unknown): AgentReviewIssue[] {
    const input = this.parse(body);
    return this.issues(input);
  }

  /**
   * Guarda el contenido del editor sin publicarlo. Si el borrador actual no está evaluado se
   * reescribe; si ya se evaluó (o está evaluando) se crea una versión nueva y la evaluación en curso
   * del borrador se cancela. Con `evaluate` se lanza la suite sobre lo guardado.
   */
  async saveDraft(actor: string, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const input = this.parse(body);
    const issues = this.issues(input);
    if (issues.length) throw new AgentReviewError(issues);
    const evaluate = b.evaluate === true;
    if (evaluate) this.requireEvaluator();
    const changeNote = parseNote(b.changeNote);
    await this.expireStale();
    const working = await this.working();
    if (working?.evalVerdict === 'RUNNING') await this.cancelEvaluation(working.id, actor);

    let saved;
    if (working?.status === 'DRAFT' && !working.evalVerdict) {
      saved = await this.prisma.agentConfigVersion.update({
        where: { id: working.id },
        data: {
          ...input,
          createdBy: actor,
          evalSummary: Prisma.DbNull,
          ...(changeNote !== undefined ? { changeNote } : {}),
        },
        select: CONTENT_SELECT,
      });
    } else {
      saved = await this.createVersion(actor, input, changeNote ?? null);
    }
    await this.audit(actor, 'AGENT_DRAFT_SAVED', `v${saved.version}`);
    if (evaluate) return this.startEvaluation(actor, saved.id);
    return saved;
  }

  /**
   * D-005: evalúa cualquier versión guardada (borrador, publicada o archivada) para dejar la
   * evidencia en su historial. No cambia su estado ni la publica.
   */
  async evaluate(actor: string, id: string) {
    this.requireEvaluator();
    await this.expireStale();
    const row = await this.prisma.agentConfigVersion.findUnique({
      where: { id },
      select: { evalVerdict: true },
    });
    if (!row) throw new ServiceError(404, 'Versión no encontrada');
    if (row.evalVerdict === 'RUNNING') {
      throw new ServiceError(409, 'Esta versión ya se está evaluando.');
    }
    return this.startEvaluation(actor, id);
  }

  /**
   * Por qué no se puede evaluar (null = se puede): sin LLM real o sin API key. D-005: ya no frena
   * la publicación del agente; los Brains (v1.9) lo siguen usando para publicar.
   */
  publishBlocker(): string | null {
    if (this.opts.provider === 'simulado') {
      return 'Evaluar requiere un proveedor de LLM real: la suite de evaluación no puede validar el guion con LLM_PROVIDER=simulado.';
    }
    if (this.opts.providerReady === false) {
      return `Evaluar requiere la API key del proveedor ${this.opts.provider} en el servidor para correr la suite de evaluación.`;
    }
    return null;
  }

  /**
   * D-005: publica al instante la versión indicada (o la de trabajo), pase o no la evaluación.
   * Después lanza la suite en segundo plano como evidencia (`evaluate`, por defecto sí) si la versión
   * no tiene resultado y el servidor puede evaluar. `reason` es una nota opcional. `applyToOpen`
   * (urgencia) pasa a la versión nueva también las conversaciones en curso; si no, terminan con la
   * versión con la que empezaron.
   */
  async publish(actor: string, body?: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
    const applyToOpen = b.applyToOpen === true;
    const evaluate = b.evaluate !== false;
    await this.expireStale();
    const working = await this.working();
    const id = typeof b.versionId === 'string' ? b.versionId : working?.id;
    if (!id)
      throw new ServiceError(409, 'No hay una versión para publicar: guarda los cambios primero.');
    const row = await this.prisma.agentConfigVersion.findUnique({ where: { id } });
    if (!row) throw new ServiceError(404, 'Versión no encontrada');
    if (row.status === 'PUBLISHED')
      throw new ServiceError(409, `La v${row.version} ya está publicada.`);
    if (row.status === 'ARCHIVED') {
      throw new ServiceError(
        409,
        'La versión está archivada: restáurala como borrador para volver a publicarla.',
      );
    }
    const issues = this.issues(row);
    if (issues.length) throw new AgentReviewError(issues);
    const verdict = (row.evalVerdict as EvalVerdict | null) ?? null;

    const r = await withSerializableRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const current = await tx.agentConfigVersion.findUnique({ where: { id } });
          if (!current || current.status !== row.status) {
            throw new ServiceError(
              409,
              'La versión cambió mientras se publicaba: vuelve a intentarlo.',
            );
          }
          await tx.agentConfigVersion.updateMany({
            where: { status: 'PUBLISHED' },
            data: { status: 'ARCHIVED' },
          });
          const now = new Date();
          await tx.agentConfigVersion.update({
            where: { id },
            data: {
              status: 'PUBLISHED',
              publishedBy: actor,
              publishedAt: now,
              publishReason: reason || null,
              appliedToOpen: applyToOpen,
            },
          });
          const moved = applyToOpen
            ? (
                await tx.conversation.updateMany({
                  where: { status: { in: [...OPEN_CONVERSATION_STATUSES] } },
                  data: { agentVersionId: id },
                })
              ).count
            : 0;
          await tx.adminAuditLog.create({
            data: {
              actor: actor.slice(0, 60),
              action: 'AGENT_PUBLISHED',
              target: `v${row.version}`,
              detail: {
                verdict,
                ...(reason ? { reason } : {}),
                applyToOpen,
                ...(applyToOpen ? { openConversations: moved } : {}),
              },
            },
          });
          return { moved };
        },
        { isolationLevel: 'Serializable' },
      ),
    );

    // Evidencia: la evaluación corre después de publicar y nunca deshace la publicación.
    let evaluation: 'STARTED' | 'RUNNING' | 'DONE' | 'SKIPPED' | 'UNAVAILABLE' | 'FAILED';
    if (verdict === 'RUNNING') evaluation = 'RUNNING';
    else if (verdict === 'OK' || verdict === 'WARN' || verdict === 'BLOCKED') evaluation = 'DONE';
    else if (!evaluate) evaluation = 'SKIPPED';
    else if (this.publishBlocker()) evaluation = 'UNAVAILABLE';
    else {
      try {
        await this.startEvaluation(actor, id);
        evaluation = 'STARTED';
      } catch {
        evaluation = 'FAILED';
      }
    }
    return {
      version: row.version,
      status: 'PUBLISHED' as const,
      verdict,
      applyToOpen,
      openConversations: r.moved,
      evaluation,
      ...(evaluation === 'UNAVAILABLE' ? { evaluationBlocker: this.publishBlocker() } : {}),
    };
  }

  /** Historial: cada versión con su nota, resultado, pruebas guardadas y conversaciones atendidas. */
  async versions(limit = 50) {
    const [rows, convs, tests] = await Promise.all([
      this.prisma.agentConfigVersion.findMany({
        orderBy: { version: 'desc' },
        take: limit,
        select: VERSION_SELECT,
      }),
      this.prisma.conversation.groupBy({
        by: ['agentVersionId'],
        where: { agentVersionId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.agentTestRecord.groupBy({
        by: ['versionId'],
        where: { versionId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const nConv = new Map(convs.map((c) => [c.agentVersionId, c._count._all]));
    const nTests = new Map(tests.map((t) => [t.versionId, t._count._all]));
    return rows.map((r) => ({
      ...r,
      conversations: nConv.get(r.id) ?? 0,
      tests: nTests.get(r.id) ?? 0,
    }));
  }

  async version(id: string) {
    const v = await this.prisma.agentConfigVersion.findUnique({
      where: { id },
      select: CONTENT_SELECT,
    });
    if (!v) throw new ServiceError(404, 'Versión no encontrada');
    return v;
  }

  /** Copia el contenido de una versión anterior como borrador (no publica nada). */
  async restore(actor: string, id: string) {
    const src = await this.prisma.agentConfigVersion.findUnique({ where: { id } });
    if (!src) throw new ServiceError(404, 'Versión no encontrada');
    const draft = await this.saveDraft(actor, {
      changeNote: `Restaurada desde la v${src.version}`,
      agentName: src.agentName,
      companyName: src.companyName,
      companyInfo: src.companyInfo,
      welcome: src.welcome,
      prompt: src.prompt,
      model: src.model && this.models().includes(src.model) ? src.model : null,
      temperature: src.temperature,
    });
    await this.audit(actor, 'AGENT_RESTORED', `v${src.version}→v${draft.version}`);
    return draft;
  }

  /**
   * "Probar agente": un turno del motor real con una conversación simulada. Un ADMIN prueba lo
   * que tiene en el editor (aunque no esté guardado, pero revisado); un OPERADOR, la versión
   * publicada. Nada se guarda ni toca Abaya.
   */
  async test(role: 'ADMIN' | 'OPERADOR', body: unknown): Promise<AgentTestResult> {
    if (!this.tester) throw new ServiceError(503, 'La prueba del agente no está disponible.');
    const b = (body ?? {}) as Record<string, unknown>;
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message || message.length > MAX_TEST_TEXT) {
      throw new ServiceError(400, `message: entre 1 y ${MAX_TEST_TEXT} caracteres`);
    }
    const state = this.parseTestState(b.state);

    let agent: AgentConfig;
    if (role === 'ADMIN' && b.source === 'editor') {
      const input = this.parse(b.fields);
      const issues = this.issues(input);
      if (issues.length) throw new AgentReviewError(issues);
      agent = { ...input, id: 'prueba-editor', version: 0 };
    } else {
      const published = await this.prisma.agentConfigVersion.findFirst({
        where: { status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
      });
      agent = published
        ? {
            id: published.id,
            version: published.version,
            agentName: published.agentName,
            companyName: published.companyName,
            companyInfo: published.companyInfo,
            welcome: published.welcome,
            prompt: published.prompt,
            model: published.model,
            temperature: published.temperature,
          }
        : DEFAULT_AGENT_CONFIG;
    }
    try {
      return await this.tester.run({ agent, state, message });
    } catch {
      throw new ServiceError(
        503,
        'El worker no respondió a la prueba (¿está en marcha y conectado a Redis?).',
      );
    }
  }

  /**
   * Guarda una prueba de "Probar agente" en el historial (texto de simulación, nunca datos de
   * clientes). `versionId` = versión probada; sin él, contenido del editor sin guardar.
   */
  async saveTest(actor: string, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const source = b.source === 'published' ? 'published' : 'editor';
    let version: { id: string; version: number } | null = null;
    if (typeof b.versionId === 'string' && b.versionId) {
      version = await this.prisma.agentConfigVersion.findUnique({
        where: { id: b.versionId },
        select: { id: true, version: true },
      });
      if (!version) throw new ServiceError(404, 'Versión no encontrada');
    }
    if (!Array.isArray(b.transcript) || !b.transcript.length) {
      throw new ServiceError(400, 'transcript: la prueba no tiene mensajes');
    }
    const transcript = b.transcript.slice(0, MAX_TEST_LINES).map((m: unknown) => {
      const r = (m ?? {}) as Record<string, unknown>;
      if (typeof r.role !== 'string' || !TEST_ROLES.has(r.role) || typeof r.text !== 'string') {
        throw new ServiceError(
          400,
          'transcript: cada línea es { role: customer | bot | event, text }',
        );
      }
      return { role: r.role, text: r.text.slice(0, MAX_TEST_TEXT) };
    });
    const finalStage = typeof b.finalStage === 'string' ? b.finalStage.slice(0, 40) : 'MENU';
    const rec = await this.prisma.agentTestRecord.create({
      data: {
        versionId: version?.id ?? null,
        version: version?.version ?? null,
        source,
        note: parseNote(b.note) ?? null,
        transcript,
        finalStage,
        createdBy: actor,
      },
    });
    await this.audit(actor, 'AGENT_TEST_SAVED', version ? `v${version.version}` : 'editor');
    return rec;
  }

  tests(versionId: string) {
    return this.prisma.agentTestRecord.findMany({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // ---------- internos ----------

  private requireEvaluator() {
    const blocker = this.publishBlocker();
    if (blocker) throw new ServiceError(409, blocker);
  }

  private async startEvaluation(actor: string, id: string) {
    const before = await this.prisma.agentConfigVersion.findUnique({
      where: { id },
      select: { evalVerdict: true, evalSummary: true, evaluatedAt: true },
    });
    // D-005: la evaluación no cambia el estado de la versión (puede estar publicada).
    const r = await this.prisma.agentConfigVersion.updateMany({
      where: { id, OR: [{ evalVerdict: null }, { evalVerdict: { not: 'RUNNING' } }] },
      data: {
        evalVerdict: 'RUNNING',
        evaluatedAt: null,
        evalSummary: { progress: { done: 0, total: null }, startedAt: new Date().toISOString() },
      },
    });
    if (!r.count) throw new ServiceError(409, 'La versión cambió: vuelve a intentarlo.');
    try {
      await this.queue.enqueue({ versionId: id, requestedBy: actor });
    } catch {
      await this.prisma.agentConfigVersion.update({
        where: { id },
        data: {
          evalVerdict: before?.evalVerdict ?? null,
          evaluatedAt: before?.evaluatedAt ?? null,
          evalSummary: (before?.evalSummary as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
        },
      });
      throw new ServiceError(503, 'No se pudo encolar la evaluación (Redis no disponible).');
    }
    const v = await this.prisma.agentConfigVersion.findUniqueOrThrow({
      where: { id },
      select: CONTENT_SELECT,
    });
    await this.audit(actor, 'AGENT_EVALUATION_REQUESTED', `v${v.version}`);
    return v;
  }

  /** Cancela una evaluación en curso (el worker la ve y se detiene). */
  private async cancelEvaluation(id: string, actor: string) {
    const r = await this.prisma.agentConfigVersion.updateMany({
      where: { id, evalVerdict: 'RUNNING' },
      data: {
        evalVerdict: 'CANCELLED',
        evaluatedAt: new Date(),
        evalSummary: {
          problems: ['evaluación cancelada: se guardó una versión más nueva'],
          finishedAt: new Date().toISOString(),
        },
      },
    });
    if (r.count) {
      const v = await this.prisma.agentConfigVersion.findUnique({
        where: { id },
        select: { version: true },
      });
      await this.audit(actor, 'AGENT_EVALUATION_CANCELLED', `v${v?.version ?? '?'}`);
    }
  }

  private parseTestState(raw: unknown): AgentTestJob['state'] {
    const s = (raw ?? {}) as Record<string, unknown>;
    const stage = s.stage ?? 'MENU';
    if (typeof stage !== 'string' || !(STAGES as readonly string[]).includes(stage)) {
      throw new ServiceError(400, 'state.stage inválido');
    }
    const profile: Record<string, string | boolean> = {};
    for (const [k, v] of Object.entries((s.profile ?? {}) as Record<string, unknown>)) {
      if (PROFILE_KEYS.has(k) && typeof v === 'string') profile[k] = v.slice(0, 200);
      if (PROFILE_FLAGS.has(k) && typeof v === 'boolean') profile[k] = v;
    }
    const history = Array.isArray(s.history) ? s.history.slice(-40) : [];
    return {
      stage: stage as Stage,
      profile,
      history: history
        .filter(
          (m): m is { role: 'customer' | 'bot'; text: string } =>
            !!m &&
            typeof m === 'object' &&
            ((m as { role?: unknown }).role === 'customer' ||
              (m as { role?: unknown }).role === 'bot') &&
            typeof (m as { text?: unknown }).text === 'string',
        )
        .map((m) => ({ role: m.role, text: m.text.slice(0, MAX_TEST_TEXT * 2) })),
    };
  }

  /** Versión de trabajo: la más nueva que no está publicada ni archivada. */
  private async working() {
    const latest = await this.prisma.agentConfigVersion.findFirst({
      orderBy: { version: 'desc' },
      select: CONTENT_SELECT,
    });
    if (!latest || latest.status === 'PUBLISHED' || latest.status === 'ARCHIVED') return null;
    return latest;
  }

  private async createVersion(
    actor: string,
    input: AgentConfigInput,
    changeNote: string | null = null,
  ) {
    // `version` es única: si dos ADMIN guardan a la vez, uno reintenta con el siguiente número.
    for (let attempt = 0; attempt < 3; attempt++) {
      const max = await this.prisma.agentConfigVersion.aggregate({ _max: { version: true } });
      // La v1 del código cuenta como versión 1 aunque no esté en la base.
      const next = Math.max(max._max.version ?? 0, DEFAULT_AGENT_CONFIG.version) + 1;
      try {
        return await this.prisma.agentConfigVersion.create({
          data: { ...input, version: next, status: 'DRAFT', createdBy: actor, changeNote },
          select: CONTENT_SELECT,
        });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    throw new ServiceError(409, 'Otro usuario guardó al mismo tiempo: vuelve a intentarlo.');
  }

  private async expireStale() {
    const stale = await this.prisma.agentConfigVersion.findMany({
      where: { evalVerdict: 'RUNNING', updatedAt: { lt: new Date(Date.now() - this.staleMs) } },
      select: { id: true, version: true },
    });
    for (const s of stale) {
      const r = await this.prisma.agentConfigVersion.updateMany({
        where: { id: s.id, evalVerdict: 'RUNNING' },
        data: {
          evalVerdict: 'ERROR',
          evaluatedAt: new Date(),
          evalSummary: {
            problems: ['la evaluación no respondió a tiempo (¿worker detenido?)'],
            finishedAt: new Date().toISOString(),
          },
        },
      });
      if (r.count) await this.audit('sistema', 'AGENT_EVALUATION_FAILED', `v${s.version}`);
    }
  }

  private issues(input: AgentConfigInput): AgentReviewIssue[] {
    const issues = reviewAgentConfig(input);
    if (input.model !== null && !this.models().includes(input.model)) {
      issues.push({ field: 'model', message: `modelo no permitido: ${input.model}` });
    }
    return issues;
  }

  private parse(body: unknown): AgentConfigInput {
    const b = (body ?? {}) as Record<string, unknown>;
    const str = (k: string) => {
      const v = b[k];
      if (typeof v !== 'string') throw new ServiceError(400, `${k} debe ser texto`);
      return v.replace(/\r\n/g, '\n');
    };
    const temperature = b.temperature;
    if (typeof temperature !== 'number') throw new ServiceError(400, 'temperature debe ser número');
    const model = b.model;
    if (model !== null && model !== undefined && typeof model !== 'string') {
      throw new ServiceError(400, 'model debe ser texto o null');
    }
    return {
      agentName: str('agentName').trim(),
      companyName: str('companyName').trim(),
      companyInfo: str('companyInfo').trim(),
      welcome: str('welcome').trim(),
      prompt: str('prompt'),
      model: model ? model : null,
      temperature,
    };
  }

  private async audit(actor: string, action: string, target?: string) {
    await this.prisma.adminAuditLog.create({ data: { actor, action, target: target ?? null } });
  }
}

/** Nota del cambio o de una prueba: texto corto opcional. */
function parseNote(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ServiceError(400, 'la nota debe ser texto');
  const t = v.trim().slice(0, 300);
  return t || undefined;
}
