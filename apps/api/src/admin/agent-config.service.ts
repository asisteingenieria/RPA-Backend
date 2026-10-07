import { Prisma, type PrismaClient } from '@abaya/db';
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

/** Encola la evaluación de una versión (el worker la corre y la publica o rechaza). */
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
const MAX_TEST_TEXT = 2_000;

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
 * Configuración del agente en el panel (v1.8, sección 6.3.8): borradores, publicación con la
 * suite de evaluación (regla 13) e historial. El contenido se revisa al guardar (regla 11).
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
      canPublish: this.publishBlocker() === null,
      publishBlocker: this.publishBlocker(),
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

  async saveDraft(actor: string, body: unknown) {
    const input = this.parse(body);
    const issues = this.issues(input);
    if (issues.length) throw new AgentReviewError(issues);
    await this.expireStale();
    const working = await this.working();
    if (working?.status === 'EVALUATING') {
      throw new ServiceError(409, 'Hay una versión en evaluación: espera el resultado.');
    }
    let saved;
    if (working?.status === 'DRAFT') {
      saved = await this.prisma.agentConfigVersion.update({
        where: { id: working.id },
        data: { ...input, createdBy: actor, evalSummary: Prisma.DbNull },
        select: CONTENT_SELECT,
      });
    } else {
      saved = await this.createVersion(actor, input);
    }
    await this.audit(actor, 'AGENT_DRAFT_SAVED', `v${saved.version}`);
    return saved;
  }

  /** Por qué no se puede publicar (null = se puede). También lo usan los Brains (v1.9). */
  publishBlocker(): string | null {
    if (this.opts.provider === 'simulado') {
      return 'Publicar requiere un proveedor de LLM real: la suite de evaluación no puede validar el guion con LLM_PROVIDER=simulado.';
    }
    if (this.opts.providerReady === false) {
      return `Publicar requiere la API key del proveedor ${this.opts.provider} en el servidor para correr la suite de evaluación.`;
    }
    return null;
  }

  async publish(actor: string) {
    const blocker = this.publishBlocker();
    if (blocker) throw new ServiceError(409, blocker);
    await this.expireStale();
    const working = await this.working();
    if (!working || working.status !== 'DRAFT') {
      throw new ServiceError(409, 'No hay un borrador para publicar: guarda los cambios primero.');
    }
    const full = await this.prisma.agentConfigVersion.findUniqueOrThrow({
      where: { id: working.id },
    });
    const issues = this.issues(full);
    if (issues.length) throw new AgentReviewError(issues);
    const r = await this.prisma.agentConfigVersion.updateMany({
      where: { id: working.id, status: 'DRAFT' },
      data: { status: 'EVALUATING', evalSummary: Prisma.DbNull },
    });
    if (!r.count) throw new ServiceError(409, 'El borrador cambió: vuelve a intentarlo.');
    try {
      await this.queue.enqueue({ versionId: working.id, requestedBy: actor });
    } catch {
      await this.prisma.agentConfigVersion.update({
        where: { id: working.id },
        data: { status: 'DRAFT' },
      });
      throw new ServiceError(503, 'No se pudo encolar la evaluación (Redis no disponible).');
    }
    await this.audit(actor, 'AGENT_PUBLISH_REQUESTED', `v${working.version}`);
    return { version: working.version, status: 'EVALUATING' as const };
  }

  versions(limit = 50) {
    return this.prisma.agentConfigVersion.findMany({
      orderBy: { version: 'desc' },
      take: limit,
      select: VERSION_SELECT,
    });
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

  // ---------- internos ----------

  private parseTestState(raw: unknown): AgentTestJob['state'] {
    const s = (raw ?? {}) as Record<string, unknown>;
    const stage = s.stage ?? 'MENU';
    if (typeof stage !== 'string' || !(STAGES as readonly string[]).includes(stage)) {
      throw new ServiceError(400, 'state.stage inválido');
    }
    const profile: Record<string, string> = {};
    for (const [k, v] of Object.entries((s.profile ?? {}) as Record<string, unknown>)) {
      if (PROFILE_KEYS.has(k) && typeof v === 'string') profile[k] = v.slice(0, 200);
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

  private async createVersion(actor: string, input: AgentConfigInput) {
    // `version` es única: si dos ADMIN guardan a la vez, uno reintenta con el siguiente número.
    for (let attempt = 0; attempt < 3; attempt++) {
      const max = await this.prisma.agentConfigVersion.aggregate({ _max: { version: true } });
      // La v1 del código cuenta como versión 1 aunque no esté en la base.
      const next = Math.max(max._max.version ?? 0, DEFAULT_AGENT_CONFIG.version) + 1;
      try {
        return await this.prisma.agentConfigVersion.create({
          data: { ...input, version: next, status: 'DRAFT', createdBy: actor },
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
      where: { status: 'EVALUATING', updatedAt: { lt: new Date(Date.now() - this.staleMs) } },
      select: { id: true, version: true },
    });
    for (const s of stale) {
      const r = await this.prisma.agentConfigVersion.updateMany({
        where: { id: s.id, status: 'EVALUATING' },
        data: {
          status: 'REJECTED',
          evalSummary: {
            problems: ['la evaluación no respondió a tiempo (¿worker detenido?)'],
            finishedAt: new Date().toISOString(),
          },
        },
      });
      if (r.count) await this.audit('sistema', 'AGENT_REJECTED', `v${s.version}`);
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
