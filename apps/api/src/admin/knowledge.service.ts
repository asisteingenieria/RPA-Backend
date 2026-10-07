import { sha256 } from '@abaya/crypto';
import { Prisma, type PrismaClient } from '@abaya/db';
import type { EvalJob } from '@abaya/domain';
import {
  checkPlanQuery,
  DEFAULT_AGENT_KEY,
  detectFile,
  diffCatalogs,
  diffAgainstPublished,
  FileRejected,
  isCatalogBrain,
  isEmptyDiff,
  KNOWLEDGE_LIMITS,
  KnowledgeError,
  loadAgentCatalog,
  planTitle,
  publishedVersion,
  rebuildDraftFromSources,
  replaceDraft,
  SALE_PROCESSES,
  versionRecords,
  versionRecordsFor,
  workingVersion,
  type BlobStore,
  type CatalogDiff,
  type KnowledgeIngestJob,
  type KnowledgeUse,
  type SaleProcess,
} from '@abaya/knowledge';
import { ServiceError } from './errors.js';

export interface KnowledgeQueues {
  ingest(job: KnowledgeIngestJob): Promise<void>;
  evaluate(job: EvalJob): Promise<void>;
}

export interface KnowledgeOptions {
  /** Igual que el agente: sin proveedor real no se puede correr la suite (regla 13). */
  publishBlocker: () => string | null;
  /** Una evaluación sin respuesta en este tiempo se da por fallida (worker caído). */
  staleEvaluationMs?: number;
}

/** Archivo recibido por multipart (multer en memoria). */
export interface UploadedFileInput {
  buffer: Buffer;
  originalname: string;
  size: number;
}

const SOURCE_SELECT = {
  id: true,
  kind: true,
  use: true,
  name: true,
  mime: true,
  sizeBytes: true,
  contentHash: true,
  status: true,
  errorReason: true,
  issues: true,
  lastIngestedAt: true,
  createdBy: true,
  createdAt: true,
} as const;

const VERSION_SELECT = {
  id: true,
  version: true,
  status: true,
  basedOn: true,
  diff: true,
  evalSummary: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  publishedBy: true,
  publishedAt: true,
  _count: { select: { records: true } },
} as const;

const AGENT_KEYS = new Set([DEFAULT_AGENT_KEY]);

/**
 * Brains en el panel (v1.9, docs/DECISIONS.md D-001). Ver: ambos roles. Crear, cargar
 * fuentes, publicar, revertir y conectar: solo ADMIN (permiso `publicarConocimiento`).
 * Todo cambio queda en AdminAuditLog; publicar pasa por la suite de evaluación.
 */
export class KnowledgeService {
  private readonly staleMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly blobs: BlobStore,
    private readonly queues: KnowledgeQueues,
    private readonly opts: KnowledgeOptions,
  ) {
    this.staleMs = opts.staleEvaluationMs ?? 30 * 60_000;
  }

  // ---------- Brains ----------

  async list() {
    await this.expireStale();
    const brains = await this.prisma.brain.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        agents: { select: { agentKey: true } },
        _count: { select: { sources: true } },
        versions: { orderBy: { version: 'desc' }, take: 5, select: VERSION_SELECT },
      },
    });
    return brains.map((b) => ({
      id: b.id,
      name: b.name,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      sources: b._count.sources,
      agents: b.agents.map((a) => a.agentKey),
      published: summary(b.versions.find((v) => v.status === 'PUBLISHED')),
      working: summary(
        b.versions[0] && !['PUBLISHED', 'ARCHIVED'].includes(b.versions[0].status)
          ? b.versions[0]
          : undefined,
      ),
    }));
  }

  async create(actor: string, body: unknown) {
    const name = this.name(body);
    try {
      const b = await this.prisma.brain.create({ data: { name, createdBy: actor } });
      await this.audit(actor, 'BRAIN_CREATED', name, { brainId: b.id });
      return { id: b.id, name: b.name };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002')
        throw new ServiceError(409, `Ya existe un Brain llamado «${name}».`);
      throw err;
    }
  }

  async get(id: string) {
    await this.expireStale();
    const b = await this.prisma.brain.findUnique({
      where: { id },
      include: {
        agents: { select: { agentKey: true, connectedBy: true, connectedAt: true } },
        sources: { orderBy: { createdAt: 'asc' }, select: SOURCE_SELECT },
        versions: { orderBy: { version: 'desc' }, take: 50, select: VERSION_SELECT },
      },
    });
    if (!b) throw new ServiceError(404, 'Brain no encontrado');
    return {
      id: b.id,
      name: b.name,
      createdBy: b.createdBy,
      createdAt: b.createdAt,
      agents: b.agents,
      sources: b.sources,
      versions: b.versions.map(summary),
      limits: { catalogMaxBytes: KNOWLEDGE_LIMITS.catalogMaxBytes },
    };
  }

  async rename(actor: string, id: string, body: unknown) {
    const name = this.name(body);
    const b = await this.brain(id);
    try {
      await this.prisma.brain.update({ where: { id }, data: { name } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002')
        throw new ServiceError(409, `Ya existe un Brain llamado «${name}».`);
      throw err;
    }
    await this.audit(actor, 'BRAIN_RENAMED', `${b.name} → ${name}`, { brainId: id });
    return { id, name };
  }

  async remove(actor: string, id: string) {
    const b = await this.prisma.brain.findUnique({
      where: { id },
      include: { agents: true, sources: { select: { blobRef: true } } },
    });
    if (!b) throw new ServiceError(404, 'Brain no encontrado');
    if (b.agents.length) {
      throw new ServiceError(409, 'Desconecta el Brain de los agentes antes de eliminarlo.');
    }
    await this.prisma.brain.delete({ where: { id } });
    for (const s of b.sources) if (s.blobRef) await this.blobs.delete(s.blobRef);
    await this.audit(actor, 'BRAIN_DELETED', b.name, { brainId: id });
    return { ok: true as const };
  }

  // ---------- fuentes ----------

  async addFile(actor: string, id: string, file: UploadedFileInput | undefined, useRaw: unknown) {
    const b = await this.brain(id);
    const use = (useRaw ?? 'CATALOG') as KnowledgeUse;
    if (use !== 'CATALOG') {
      throw new ServiceError(
        400,
        'Por ahora solo se cargan catálogos (Excel o CSV); los demás usos llegan en las fases K3 y K4.',
      );
    }
    if (!file?.buffer?.length)
      throw new ServiceError(400, 'Adjunta un archivo en el campo "file".');
    if (file.size > KNOWLEDGE_LIMITS.catalogMaxBytes) {
      throw new ServiceError(
        400,
        `El archivo supera ${KNOWLEDGE_LIMITS.catalogMaxBytes / 1024 / 1024} MB.`,
      );
    }
    const name = sanitizeFilename(file.originalname);
    const bytes = new Uint8Array(file.buffer);
    let detected;
    try {
      detected = await detectFile(bytes, name, ['xlsx', 'csv']);
    } catch (err) {
      if (err instanceof FileRejected)
        throw new ServiceError(400, `Archivo rechazado: ${err.message}.`);
      throw err;
    }
    await this.assertNotEvaluating(id);
    const contentHash = sha256(Buffer.from(bytes));
    if (
      await this.prisma.knowledgeSource.findUnique({
        where: { brainId_contentHash: { brainId: id, contentHash } },
      })
    ) {
      throw new ServiceError(409, 'Ese archivo ya está cargado en este Brain.');
    }
    const blobRef = await this.blobs.put(bytes);
    const source = await this.prisma.knowledgeSource.create({
      data: {
        brainId: id,
        kind: 'FILE',
        use,
        name,
        mime: detected.mime,
        sizeBytes: bytes.length,
        contentHash,
        blobRef,
        createdBy: actor,
        issues: detected.warnings.map((message) => ({ message })) as Prisma.InputJsonValue,
      },
      select: SOURCE_SELECT,
    });
    await this.audit(actor, 'BRAIN_SOURCE_ADDED', `${b.name} · ${name}`, {
      brainId: id,
      sourceId: source.id,
      sizeBytes: bytes.length,
      contentHash,
    });
    await this.enqueueIngest(source.id, actor);
    return source;
  }

  async removeSource(actor: string, id: string, sourceId: string) {
    const b = await this.brain(id);
    await this.assertNotEvaluating(id);
    const s = await this.prisma.knowledgeSource.findFirst({ where: { id: sourceId, brainId: id } });
    if (!s) throw new ServiceError(404, 'Fuente no encontrada');
    await this.prisma.knowledgeSource.delete({ where: { id: s.id } });
    if (s.blobRef) await this.blobs.delete(s.blobRef);
    await this.prisma.brain.update({ where: { id }, data: { sourcesChangedAt: new Date() } });
    const draft = await this.knowledge(rebuildDraftFromSources(this.prisma, id, actor));
    await this.audit(actor, 'BRAIN_SOURCE_REMOVED', `${b.name} · ${s.name}`, {
      brainId: id,
      sourceId: s.id,
      draftVersion: draft.version,
    });
    return { draftVersion: draft.version, diff: draft.diff };
  }

  async reprocess(actor: string, id: string, sourceId: string) {
    const b = await this.brain(id);
    await this.assertNotEvaluating(id);
    const r = await this.prisma.knowledgeSource.updateMany({
      where: { id: sourceId, brainId: id, status: { not: 'PROCESSING' } },
      data: { status: 'PROCESSING', errorReason: null },
    });
    if (!r.count) throw new ServiceError(409, 'La fuente no existe o ya se está procesando.');
    await this.audit(actor, 'BRAIN_SOURCE_REPROCESSED', b.name, { brainId: id, sourceId });
    await this.enqueueIngest(sourceId, actor);
    return { ok: true as const };
  }

  // ---------- versiones ----------

  async versions(id: string) {
    await this.brain(id);
    const vs = await this.prisma.brainVersion.findMany({
      where: { brainId: id },
      orderBy: { version: 'desc' },
      select: VERSION_SELECT,
    });
    return vs.map(summary);
  }

  /** Vista previa del catálogo de una versión, opcionalmente filtrada por proceso. */
  async version(id: string, version: number, processRaw?: unknown) {
    const v = await this.versionRow(id, version);
    const process = processRaw ? this.process(processRaw) : undefined;
    const records = process
      ? await versionRecordsFor(this.prisma, v.id, process)
      : await versionRecords(this.prisma, v.id);
    return { ...summary(v), records: records.map((r) => ({ ...r, title: planTitle(r) })) };
  }

  /** Diferencias de la versión contra otra (`against`) o contra la publicada. */
  async diff(id: string, version: number, againstRaw?: unknown) {
    const v = await this.versionRow(id, version);
    const records = await versionRecords(this.prisma, v.id);
    if (againstRaw !== undefined && againstRaw !== '' && againstRaw !== 'published') {
      const other = await this.versionRow(id, Number(againstRaw));
      const before = await versionRecords(this.prisma, other.id);
      return { version, against: other.version, diff: diffCatalogs(before, records) };
    }
    const { diff, publishedVersion: pub } = await diffAgainstPublished(this.prisma, id, records);
    return { version, against: pub, diff };
  }

  async publish(actor: string, id: string) {
    const blocker = this.opts.publishBlocker();
    if (blocker) throw new ServiceError(409, blocker);
    const b = await this.brain(id);
    await this.expireStale();
    if (await this.prisma.knowledgeSource.count({ where: { brainId: id, status: 'PROCESSING' } })) {
      throw new ServiceError(409, 'Hay fuentes procesándose: espera a que terminen.');
    }
    const working = await workingVersion(this.prisma, id);
    if (working?.status !== 'DRAFT') {
      throw new ServiceError(409, 'No hay un borrador para publicar.');
    }
    const records = await versionRecords(this.prisma, working.id);
    const { diff } = await diffAgainstPublished(this.prisma, id, records);
    if (isEmptyDiff(diff))
      throw new ServiceError(409, 'El borrador es igual a la versión publicada.');
    const r = await this.prisma.brainVersion.updateMany({
      where: { id: working.id, status: 'DRAFT' },
      data: {
        status: 'EVALUATING',
        diff: diff as unknown as Prisma.InputJsonValue,
        evalSummary: Prisma.DbNull,
      },
    });
    if (!r.count) throw new ServiceError(409, 'El borrador cambió: vuelve a intentarlo.');
    try {
      await this.queues.evaluate({ versionId: working.id, requestedBy: actor, kind: 'brain' });
    } catch {
      await this.prisma.brainVersion.update({
        where: { id: working.id },
        data: { status: 'DRAFT' },
      });
      throw new ServiceError(503, 'No se pudo encolar la evaluación (Redis no disponible).');
    }
    await this.audit(actor, 'BRAIN_PUBLISH_REQUESTED', `${b.name} v${working.version}`, {
      brainId: id,
      version: working.version,
      diff,
    });
    return { version: working.version, status: 'EVALUATING' as const, diff };
  }

  /** Revertir: borrador copia de una versión anterior (se publica con la suite, como todo). */
  async restore(actor: string, id: string, version: number) {
    const b = await this.brain(id);
    const src = await this.versionRow(id, version);
    const records = await versionRecords(this.prisma, src.id);
    const draft = await this.knowledge(replaceDraft(this.prisma, id, records, actor, src.version));
    if (draft.version === null) throw new ServiceError(409, 'Esa versión es igual a la publicada.');
    await this.audit(actor, 'BRAIN_RESTORED', `${b.name} v${src.version}→v${draft.version}`, {
      brainId: id,
      from: src.version,
      draftVersion: draft.version,
      diff: draft.diff,
    });
    return { version: draft.version, diff: draft.diff };
  }

  // ---------- agentes ----------

  async connect(actor: string, agentKey: string, brainId: string) {
    this.agentKey(agentKey);
    const b = await this.brain(brainId);
    if (await isCatalogBrain(this.prisma, brainId)) {
      if (!(await publishedVersion(this.prisma, brainId))) {
        throw new ServiceError(409, 'Publica el catálogo antes de conectarlo a un agente.');
      }
      const others = await this.prisma.agentBrain.findMany({
        where: { agentKey, brainId: { not: brainId } },
        select: { brainId: true, brain: { select: { name: true } } },
      });
      for (const o of others) {
        if (await isCatalogBrain(this.prisma, o.brainId)) {
          throw new ServiceError(
            409,
            `El agente ya usa el catálogo «${o.brain.name}»: desconéctalo primero (un solo catálogo por agente).`,
          );
        }
      }
    }
    await this.prisma.agentBrain.upsert({
      where: { agentKey_brainId: { agentKey, brainId } },
      create: { agentKey, brainId, connectedBy: actor },
      update: {},
    });
    await this.audit(actor, 'BRAIN_CONNECTED', `${b.name} → ${agentKey}`, { brainId, agentKey });
    return { ok: true as const };
  }

  async disconnect(actor: string, agentKey: string, brainId: string) {
    this.agentKey(agentKey);
    const b = await this.brain(brainId);
    const r = await this.prisma.agentBrain.deleteMany({ where: { agentKey, brainId } });
    if (!r.count) throw new ServiceError(404, 'El Brain no está conectado a ese agente.');
    await this.audit(actor, 'BRAIN_DISCONNECTED', `${b.name} → ${agentKey}`, { brainId, agentKey });
    return { ok: true as const };
  }

  async agentBrains(agentKey: string) {
    this.agentKey(agentKey);
    const links = await this.prisma.agentBrain.findMany({
      where: { agentKey },
      select: { connectedBy: true, connectedAt: true, brain: { select: { id: true, name: true } } },
    });
    return links.map((l) => ({
      ...l.brain,
      connectedBy: l.connectedBy,
      connectedAt: l.connectedAt,
    }));
  }

  // ---------- prueba ----------

  /**
   * Lo que devolvería `consultar_planes(proceso)` con la versión publicada (o el borrador):
   * el mismo filtro exacto y la misma verificación que usa el motor.
   */
  async test(id: string, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const process = this.process(b.process);
    const target =
      b.version === 'draft'
        ? await workingVersion(this.prisma, id)
        : await publishedVersion(this.prisma, id);
    await this.brain(id);
    if (!target) {
      throw new ServiceError(
        404,
        b.version === 'draft' ? 'No hay borrador.' : 'El Brain no tiene versión publicada.',
      );
    }
    const records = await versionRecordsFor(this.prisma, target.id, process);
    const result = checkPlanQuery(records, process);
    return {
      version: target.version,
      status: result.status,
      process,
      plans: result.plans.map((r) => ({ ...r, title: planTitle(r) })),
    };
  }

  /** Catálogo publicado del agente, en la forma que espera el panel del agente (v1.8). */
  async agentCatalogForPanel() {
    const c = await loadAgentCatalog(this.prisma).catch(() => null);
    return (c?.records ?? []).map((r) => ({
      code: r.code,
      process: r.process,
      name: planTitle(r),
      dataGb: Number(/(\d+)/.exec(r.dataText)?.[1] ?? 0),
      dataText: r.dataText,
      priceCop: r.priceCop,
      benefits: [
        r.includesText,
        r.extrasText,
        r.unlimitedAppsText,
        r.callsText,
        r.sharedDataText,
      ].filter((x): x is string => !!x),
      discountText: r.discountText,
      validTo: null,
    }));
  }

  // ---------- internos ----------

  private async enqueueIngest(sourceId: string, actor: string) {
    try {
      await this.queues.ingest({ sourceId, requestedBy: actor });
    } catch {
      await this.prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: {
          status: 'ERROR',
          errorReason: 'no se pudo encolar el procesamiento (Redis no disponible): usa Reprocesar',
        },
      });
      throw new ServiceError(503, 'No se pudo encolar el procesamiento (Redis no disponible).');
    }
  }

  private async assertNotEvaluating(brainId: string) {
    await this.expireStale();
    const w = await workingVersion(this.prisma, brainId);
    if (w?.status === 'EVALUATING') {
      throw new ServiceError(
        409,
        'Hay una versión en evaluación: espera el resultado para cambiar las fuentes.',
      );
    }
  }

  private async expireStale() {
    const stale = await this.prisma.brainVersion.findMany({
      where: { status: 'EVALUATING', updatedAt: { lt: new Date(Date.now() - this.staleMs) } },
      select: { id: true, version: true, brain: { select: { id: true, name: true } } },
    });
    for (const s of stale) {
      const r = await this.prisma.brainVersion.updateMany({
        where: { id: s.id, status: 'EVALUATING' },
        data: {
          status: 'REJECTED',
          evalSummary: {
            problems: ['la evaluación no respondió a tiempo (¿worker detenido?)'],
            finishedAt: new Date().toISOString(),
          },
        },
      });
      if (r.count)
        await this.audit('sistema', 'BRAIN_REJECTED', `${s.brain.name} v${s.version}`, {
          brainId: s.brain.id,
        });
    }
  }

  private async brain(id: string) {
    const b = await this.prisma.brain.findUnique({ where: { id } });
    if (!b) throw new ServiceError(404, 'Brain no encontrado');
    return b;
  }

  private async versionRow(brainId: string, version: number) {
    if (!Number.isInteger(version) || version < 1) throw new ServiceError(400, 'versión inválida');
    const v = await this.prisma.brainVersion.findUnique({
      where: { brainId_version: { brainId, version } },
      select: VERSION_SELECT,
    });
    if (!v) throw new ServiceError(404, 'Versión no encontrada');
    return v;
  }

  private name(body: unknown): string {
    const raw = (body as { name?: unknown } | null)?.name;
    const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > KNOWLEDGE_LIMITS.brainNameMax) {
      throw new ServiceError(400, `name: entre 1 y ${KNOWLEDGE_LIMITS.brainNameMax} caracteres`);
    }
    return name;
  }

  private process(raw: unknown): SaleProcess {
    if (typeof raw !== 'string' || !(SALE_PROCESSES as readonly string[]).includes(raw)) {
      throw new ServiceError(400, `process: uno de ${SALE_PROCESSES.join(', ')}`);
    }
    return raw as SaleProcess;
  }

  private agentKey(key: string) {
    if (!AGENT_KEYS.has(key)) throw new ServiceError(404, 'Agente no encontrado');
  }

  private async knowledge<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof KnowledgeError) throw new ServiceError(err.status, err.message);
      throw err;
    }
  }

  private async audit(
    actor: string,
    action: string,
    target: string,
    detail: Record<string, unknown>,
  ) {
    await this.prisma.adminAuditLog.create({
      data: { actor, action, target, detail: detail as Prisma.InputJsonValue },
    });
  }
}

type VersionRow = {
  id: string;
  version: number;
  status: string;
  basedOn: number | null;
  diff: Prisma.JsonValue;
  evalSummary: Prisma.JsonValue;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  publishedBy: string | null;
  publishedAt: Date | null;
  _count: { records: number };
};

type VersionSummary = Omit<VersionRow, '_count' | 'diff'> & {
  records: number;
  diff: CatalogDiff | null;
  changes: { added: number; removed: number; changed: number } | null;
};

function summary(v: VersionRow): VersionSummary;
function summary(v: VersionRow | undefined): VersionSummary | null;
function summary(v: VersionRow | undefined): VersionSummary | null {
  if (!v) return null;
  const { _count, diff, ...rest } = v;
  const d = (diff ?? null) as CatalogDiff | null;
  return {
    ...rest,
    records: _count.records,
    diff: d,
    changes: d
      ? { added: d.added.length, removed: d.removed.length, changed: d.changed.length }
      : null,
  };
}

/** Solo el nombre base, sin rutas ni caracteres de control. */
function sanitizeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? 'archivo')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (base || 'archivo').slice(0, KNOWLEDGE_LIMITS.sourceNameMax);
}
