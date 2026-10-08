import { chainHash, sha256, type FieldCipher } from '@abaya/crypto';
import { Prisma, utcParam, type ConversationStatus, type PrismaClient } from '@abaya/db';
import {
  DEFAULT_AGENT_CONFIG,
  consentAad,
  inboundAad,
  outboundAad,
  profileAad,
  saleAad,
  CONVERSATION_STATUSES,
  STAGES,
} from '@abaya/domain';
import { startOfBogotaDay } from './admin.service.js';
import { ServiceError } from './errors.js';

/**
 * Trazabilidad (D-002): cada conversación del robot con el cliente, COMPLETA y sin enmascarar,
 * con su tipificación, su recorrido y el rendimiento por robot. Solo para ADMIN (lo valida el
 * controlador). Cada apertura y exportación queda en Auditoría.
 *
 * El contenido está cifrado en la base: se descifra aquí, solo para la respuesta, y nunca se
 * escribe en logs (regla 6).
 */

export const TEXT_SEARCH_MAX_DAYS = 30;
const MAX_RANGE_DAYS = 366;
/** Tope de conversaciones que se procesan en una consulta (el filtro se arma en memoria). */
const MAX_ROWS = 20_000;
const DAY_MS = 86_400_000;
/** Una apertura repetida del mismo usuario dentro de esta ventana no se vuelve a auditar (refresco). */
const VIEW_AUDIT_WINDOW_MS = 10 * 60_000;

export const OPEN_STATUSES: readonly ConversationStatus[] = [
  'ACTIVE',
  'WAITING_CONSENT',
  'TRANSFERRING',
  'NEEDS_REVIEW',
];
const PROCESSES = ['PORTABILIDAD', 'MIGRACION', 'LINEA_NUEVA'] as const;
type Process = (typeof PROCESSES)[number];

export type RangePreset = 'hoy' | '7d' | '30d' | 'custom';
export type TraceFlag = 'UNCERTAIN_SEND' | 'REVIEW' | 'REGENERATED';

export interface ConversationFilters {
  range: RangePreset;
  from: Date;
  to: Date;
  robots: string[];
  statuses: ConversationStatus[];
  processes: Process[];
  stages: string[];
  reviewed?: boolean;
  /** D-004: versión del guion con la que empezó la conversación. */
  agentVersion?: number;
  q?: string;
  offset: number;
  limit: number;
}

export interface ConversationListItem {
  id: string;
  createdAt: string;
  updatedAt: string | null;
  closed: boolean;
  robotUser: string;
  abayaChatId: string;
  customerName: string | null;
  status: ConversationStatus;
  stage: string;
  process: Process | null;
  planCode: string | null;
  inbound: number;
  outbound: number;
  firstResponseMs: number | null;
  durationMs: number | null;
  flags: TraceFlag[];
  contentPurged: boolean;
  /** D-004: versión del guion con la que se atendió (null = antes de fijar versiones). */
  agentVersion: number | null;
}

interface Profile {
  process?: string;
  name?: string;
  currentOperator?: string;
  usage?: string;
}

/** Fila enriquecida: lo que necesitan la lista, los KPIs, el rendimiento y la navegación. */
interface Row extends ConversationListItem {
  sale: boolean;
  regenerations: number;
  uncertainSends: number;
}

export class ConversationsError extends ServiceError {}

const one = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;
const list = (v: unknown): string[] =>
  (one(v) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const percentile = (sorted: number[], p: number): number | null => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo));
};
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

/** `YYYY-MM-DD` como día de Bogotá (UTC-5). */
function bogotaDay(raw: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ConversationsError(400, `${field} debe tener el formato AAAA-MM-DD`);
  }
  const d = new Date(`${raw}T05:00:00.000Z`);
  if (Number.isNaN(d.getTime()))
    throw new ConversationsError(400, `${field} no es una fecha válida`);
  return d;
}

/** Lee y valida los filtros de la query string (mismos nombres que usa el panel). */
export function parseFilters(q: Record<string, unknown>, now = new Date()): ConversationFilters {
  const range = (one(q.range) ?? '7d') as RangePreset;
  let from: Date;
  let to = now;
  switch (range) {
    case 'hoy':
      from = startOfBogotaDay(now);
      break;
    case '7d':
      from = new Date(now.getTime() - 7 * DAY_MS);
      break;
    case '30d':
      from = new Date(now.getTime() - 30 * DAY_MS);
      break;
    case 'custom': {
      const f = one(q.from);
      const t = one(q.to);
      if (!f || !t) throw new ConversationsError(400, 'El rango personalizado necesita from y to');
      from = bogotaDay(f, 'from');
      to = new Date(bogotaDay(t, 'to').getTime() + DAY_MS); // incluye todo el día final
      if (to <= from) throw new ConversationsError(400, 'from debe ser anterior o igual a to');
      if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw new ConversationsError(400, `El rango máximo es de ${MAX_RANGE_DAYS} días`);
      }
      break;
    }
    default:
      throw new ConversationsError(400, 'range debe ser hoy, 7d, 30d o custom');
  }

  const statuses = list(q.status);
  const bad = statuses.find((s) => !CONVERSATION_STATUSES.includes(s as ConversationStatus));
  if (bad) throw new ConversationsError(400, `Tipificación desconocida: ${bad}`);
  const processes = list(q.process);
  const badP = processes.find((p) => !PROCESSES.includes(p as Process));
  if (badP) throw new ConversationsError(400, `Proceso desconocido: ${badP}`);
  const stages = list(q.stage);
  const badS = stages.find((s) => !(STAGES as readonly string[]).includes(s));
  if (badS) throw new ConversationsError(400, `Etapa desconocida: ${badS}`);

  const reviewedRaw = one(q.reviewed);
  if (reviewedRaw !== undefined && reviewedRaw !== 'true' && reviewedRaw !== 'false') {
    throw new ConversationsError(400, 'reviewed debe ser true o false');
  }
  const versionRaw = one(q.version);
  const agentVersion = versionRaw === undefined ? undefined : Number(versionRaw);
  if (agentVersion !== undefined && (!Number.isInteger(agentVersion) || agentVersion < 1)) {
    throw new ConversationsError(400, 'version debe ser un número de versión del agente');
  }
  const text = one(q.q)?.trim() || undefined;
  if (text && to.getTime() - from.getTime() > TEXT_SEARCH_MAX_DAYS * DAY_MS + 60_000) {
    throw new ConversationsError(
      400,
      `La búsqueda funciona en rangos de hasta ${TEXT_SEARCH_MAX_DAYS} días: los mensajes están cifrados y el servidor los descifra para buscar. Reduce el rango.`,
    );
  }
  const offset = Number(one(q.cursor) ?? 0);
  const limit = Number(one(q.limit) ?? 25);
  return {
    range,
    from,
    to,
    robots: list(q.robot),
    statuses: statuses as ConversationStatus[],
    processes: processes as Process[],
    stages,
    ...(reviewedRaw !== undefined ? { reviewed: reviewedRaw === 'true' } : {}),
    ...(agentVersion !== undefined ? { agentVersion } : {}),
    ...(text ? { q: text.slice(0, 200) } : {}),
    offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
    limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 25,
  };
}

export class ConversationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: FieldCipher,
    private readonly opts: { retentionDays: number | null },
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- lista

  async list(f: ConversationFilters) {
    const rows = await this.filtered(f);
    const page = rows.slice(f.offset, f.offset + f.limit);
    const strip = (r: Row): ConversationListItem => {
      const item: Partial<Row> = { ...r };
      delete item.sale;
      delete item.regenerations;
      delete item.uncertainSends;
      return item as ConversationListItem;
    };
    return {
      items: page.map(strip),
      total: rows.length,
      offset: f.offset,
      nextCursor: f.offset + f.limit < rows.length ? String(f.offset + f.limit) : null,
      prevCursor: f.offset > 0 ? String(Math.max(0, f.offset - f.limit)) : null,
      kpis: this.kpis(rows),
      retentionDays: this.opts.retentionDays,
    };
  }

  /** Rendimiento comparado por robot en el rango (los demás filtros también aplican). */
  async stats(f: ConversationFilters) {
    const rows = await this.filtered(f);
    const byRobot = new Map<string, Row[]>();
    for (const r of rows) byRobot.set(r.robotUser, [...(byRobot.get(r.robotUser) ?? []), r]);
    const hosts = new Map(
      (
        await this.prisma.robot.findMany({
          where: { robotUser: { in: [...byRobot.keys()] } },
          select: { robotUser: true, host: true },
        })
      ).map((r) => [r.robotUser, r.host]),
    );
    return {
      total: rows.length,
      rows: [...byRobot.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([robotUser, rs]) => {
          const k = this.kpis(rs);
          return {
            robotUser,
            hostname: hosts.get(robotUser) ?? null,
            total: rs.length,
            byTipificacion: k.byTipificacion,
            sales: k.sales,
            conversionPct: k.conversionPct,
            firstResponseP95Ms: k.firstResponseP95Ms,
            uncertainSends: rs.reduce((a, r) => a + r.uncertainSends, 0),
            regenerations: rs.reduce((a, r) => a + r.regenerations, 0),
          };
        }),
    };
  }

  private kpis(rows: Row[]) {
    const byTipificacion: Partial<Record<ConversationStatus, number>> = {};
    for (const r of rows) byTipificacion[r.status] = (byTipificacion[r.status] ?? 0) + 1;
    const sales = rows.filter((r) => r.sale).length;
    const fr = rows
      .map((r) => r.firstResponseMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const durations = rows.map((r) => r.durationMs).filter((v): v is number => v !== null);
    return {
      total: rows.length,
      sales,
      conversionPct: pct(sales, rows.length),
      firstResponseP50Ms: percentile(fr, 0.5),
      firstResponseP95Ms: percentile(fr, 0.95),
      avgDurationMs: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null,
      byTipificacion,
    };
  }

  /**
   * Conversaciones del filtro, más recientes primero. Lo que se puede filtrar en SQL se filtra
   * ahí; el proceso, el nombre y el texto viven cifrados y se filtran después de descifrar.
   */
  private async filtered(f: ConversationFilters): Promise<Row[]> {
    const reviewedIds = await this.reviewedIds(f.from);
    const where: Prisma.ConversationWhereInput = {
      createdAt: { gte: f.from, lt: f.to },
      ...(f.robots.length ? { robotUser: { in: f.robots } } : {}),
      ...(f.statuses.length ? { status: { in: f.statuses } } : {}),
      ...(f.stages.length ? { stage: { in: f.stages } } : {}),
    };
    if (f.agentVersion !== undefined) {
      const ids = await this.versionIds(f.agentVersion);
      where.agentVersionId = { in: ids.length ? ids : ['__ninguna__'] };
    }
    if (f.reviewed !== undefined) {
      const reviewed = {
        OR: [{ status: 'NEEDS_REVIEW' as const }, { id: { in: [...reviewedIds] } }],
      };
      where.AND = f.reviewed ? [reviewed] : [{ NOT: reviewed }];
    }
    const total = await this.prisma.conversation.count({ where });
    if (total > MAX_ROWS) {
      throw new ConversationsError(
        400,
        `El filtro trae ${total} conversaciones (máximo ${MAX_ROWS}). Reduce el rango o agrega filtros.`,
      );
    }
    const convs = await this.prisma.conversation.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        abayaChatId: true,
        robotUser: true,
        status: true,
        stage: true,
        profileEncrypted: true,
        contentPurgedAt: true,
        agentVersionId: true,
        createdAt: true,
        updatedAt: true,
        sale: { select: { planCode: true, process: true } },
      },
    });
    if (!convs.length) return [];
    const ids = convs.map((c) => c.id);
    const versionOf = await this.versionNumbers(convs.map((c) => c.agentVersionId));

    const [counts, firstResponses, regenerated, uncertain] = await Promise.all([
      this.prisma.message.groupBy({
        by: ['conversationId', 'direction'],
        where: { conversationId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ conversationId: string; ms: number | null }[]>`
        SELECT DISTINCT ON (m."conversationId") m."conversationId",
               EXTRACT(EPOCH FROM (m."sentAt" - m."respondsToAt")) * 1000 AS ms
        FROM "Message" m
        WHERE m."conversationId" = ANY(${ids}) AND m.direction = 'OUTBOUND'
          AND m."respondsToAt" IS NOT NULL AND m."sentAt" IS NOT NULL
        ORDER BY m."conversationId", m."occurredAt" ASC`,
      this.prisma.llmCall.groupBy({
        by: ['conversationId'],
        where: {
          conversationId: { in: ids },
          validationResult: { in: ['REGENERATED', 'FALLBACK'] },
        },
        _count: { _all: true },
      }),
      this.prisma.rpaActionLog.groupBy({
        by: ['abayaChatId'],
        where: {
          abayaChatId: { in: convs.map((c) => c.abayaChatId) },
          result: 'UNCERTAIN',
        },
        _count: { _all: true },
      }),
    ]);
    const inbound = new Map<string, number>();
    const outbound = new Map<string, number>();
    for (const c of counts) {
      (c.direction === 'INBOUND' ? inbound : outbound).set(c.conversationId, c._count._all);
    }
    const first = new Map(
      firstResponses.map((r) => [
        r.conversationId,
        r.ms === null ? null : Math.max(0, Math.round(Number(r.ms))),
      ]),
    );
    const regen = new Map(regenerated.map((r) => [r.conversationId, r._count._all]));
    const unc = new Map(uncertain.map((r) => [r.abayaChatId ?? '', r._count._all]));
    const uncertainMsgs = new Set(
      (
        await this.prisma.message.findMany({
          where: { conversationId: { in: ids }, status: 'UNCERTAIN' },
          select: { conversationId: true },
        })
      ).map((m) => m.conversationId),
    );

    let rows: Row[] = convs.map((c) => {
      const profile = this.profile(c.id, c.profileEncrypted);
      const closed = !OPEN_STATUSES.includes(c.status);
      const process = (c.sale?.process ?? profile.process ?? null) as Process | null;
      // El mismo envío incierto aparece como acción del robot y como mensaje: no se suma dos veces.
      const uncertainSends = Math.max(unc.get(c.abayaChatId) ?? 0, uncertainMsgs.has(c.id) ? 1 : 0);
      const reviewed = c.status === 'NEEDS_REVIEW' || reviewedIds.has(c.id);
      const regenerations = regen.get(c.id) ?? 0;
      const flags: TraceFlag[] = [];
      if (uncertainSends) flags.push('UNCERTAIN_SEND');
      if (reviewed) flags.push('REVIEW');
      if (regenerations) flags.push('REGENERATED');
      return {
        id: c.id,
        createdAt: c.createdAt.toISOString(),
        updatedAt: closed ? c.updatedAt.toISOString() : null,
        closed,
        robotUser: c.robotUser,
        abayaChatId: c.abayaChatId,
        customerName: profile.name?.trim() || null,
        status: c.status,
        stage: c.stage,
        process: PROCESSES.includes(process as Process) ? process : null,
        planCode: c.sale?.planCode ?? null,
        inbound: inbound.get(c.id) ?? 0,
        outbound: outbound.get(c.id) ?? 0,
        firstResponseMs: first.get(c.id) ?? null,
        durationMs: closed ? Math.max(0, c.updatedAt.getTime() - c.createdAt.getTime()) : null,
        flags,
        contentPurged: !!c.contentPurgedAt,
        agentVersion: c.agentVersionId ? (versionOf.get(c.agentVersionId) ?? null) : null,
        sale: !!c.sale,
        regenerations,
        uncertainSends,
      };
    });

    if (f.processes.length) rows = rows.filter((r) => r.process && f.processes.includes(r.process));
    if (f.q) rows = await this.search(rows, f.q);
    return rows;
  }

  /** Busca en el id del chat, el nombre del cliente y el texto de los mensajes (descifrado). */
  private async search(rows: Row[], q: string): Promise<Row[]> {
    const needle = norm(q);
    const hit = new Set(
      rows
        .filter(
          (r) =>
            norm(r.abayaChatId).includes(needle) ||
            (r.customerName && norm(r.customerName).includes(needle)),
        )
        .map((r) => r.id),
    );
    const rest = rows.filter((r) => !hit.has(r.id) && !r.contentPurged).map((r) => r.id);
    for (let i = 0; i < rest.length; i += 500) {
      const msgs = await this.prisma.message.findMany({
        where: { conversationId: { in: rest.slice(i, i + 500) } },
        select: {
          conversationId: true,
          direction: true,
          fingerprint: true,
          idempotencyKey: true,
          bodyEncrypted: true,
        },
      });
      for (const m of msgs) {
        if (hit.has(m.conversationId)) continue;
        const text = this.body(m);
        if (text && norm(text).includes(needle)) hit.add(m.conversationId);
      }
    }
    return rows.filter((r) => hit.has(r.id));
  }

  /** Conversaciones que pasaron por revisión humana (evento NeedsReview) desde una fecha. */
  private async reviewedIds(from: Date): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT DISTINCT payload->>'conversationId' AS id
      FROM "OutboxEvent"
      WHERE type = 'NeedsReview' AND "createdAt" >= ${utcParam(from)}`;
    return new Set(rows.map((r) => r.id).filter((v): v is string => !!v));
  }

  // ---------------------------------------------------------------- detalle

  /** Conversación completa. `f` (opcional) da la posición en el filtro para anterior/siguiente. */
  async detail(ref: string, actor: string, f?: ConversationFilters) {
    // Acepta el id interno o el id del chat de Abaya (En vivo y Robots solo conocen el segundo).
    const c =
      (await this.prisma.conversation.findUnique({
        where: { id: ref },
        include: { sale: true },
      })) ??
      (await this.prisma.conversation.findUnique({
        where: { abayaChatId: ref },
        include: { sale: true },
      }));
    if (!c) throw new ConversationsError(404, 'Conversación no encontrada');
    const id = c.id;

    const [messages, consentRows, llmCalls, usage, actions, outbox] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId: id },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.consentEvidence.findMany({
        where: { conversationId: id },
        orderBy: { seq: 'asc' },
      }),
      this.prisma.llmCall.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.knowledgeUsage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.rpaActionLog.findMany({
        where: { abayaChatId: c.abayaChatId, robotUser: c.robotUser },
        orderBy: { seq: 'asc' },
        take: 500,
      }),
      this.prisma.$queryRaw<{ type: string; payload: Record<string, unknown>; createdAt: Date }[]>`
        SELECT type, payload, "createdAt" FROM "OutboxEvent"
        WHERE payload->>'conversationId' = ${id}
          AND type IN ('NeedsReview', 'TransferRequested', 'ConversationClosed')
        ORDER BY "createdAt" ASC`,
    ]);

    const profile = this.profile(c.id, c.profileEncrypted);
    const closed = !OPEN_STATUSES.includes(c.status);

    const traceMessages = messages.map((m) => {
      const bot = m.direction === 'OUTBOUND';
      const at = bot ? (m.sentAt ?? m.occurredAt) : m.occurredAt;
      return {
        id: m.id,
        from: bot ? ('bot' as const) : ('client' as const),
        text: this.body(m) ?? '',
        sentAt: at.toISOString(),
        ...(bot
          ? {
              delivery: {
                status:
                  m.status === 'SENT_VERIFIED'
                    ? 'VERIFIED'
                    : m.status === 'UNCERTAIN'
                      ? 'UNCERTAIN'
                      : m.status === 'FAILED'
                        ? 'FAILED'
                        : 'PENDING',
                attempts: Math.max(1, m.attempts),
              },
              responseMs:
                m.respondsToAt && m.sentAt
                  ? Math.max(0, m.sentAt.getTime() - m.respondsToAt.getTime())
                  : null,
            }
          : {}),
      };
    });

    // Precios mostrados: el código viene de KnowledgeUsage y el precio de la versión del catálogo usada.
    const rendered = usage.filter((u) => u.kind === 'CATALOG' && u.rendered.length);
    const records = rendered.length
      ? await this.prisma.catalogRecord.findMany({
          where: {
            OR: rendered.map((u) => ({
              brainVersionId: u.brainVersionId,
              code: { in: u.rendered },
            })),
          },
          select: { brainVersionId: true, code: true, priceCop: true },
        })
      : [];
    const price = new Map(records.map((r) => [`${r.brainVersionId}:${r.code}`, r.priceCop]));
    const knowledgeUsage = rendered.flatMap((u) =>
      u.rendered.map((code) => ({
        at: u.createdAt.toISOString(),
        planCode: code,
        priceShown: price.get(`${u.brainVersionId}:${code}`) ?? null,
      })),
    );
    const lastUsage = usage.at(-1);

    const events: { at: string; kind: string; detail?: string }[] = rendered.map((u) => ({
      at: u.createdAt.toISOString(),
      kind: 'PLAN_OFFERED',
      detail: u.rendered.join(', '),
    }));
    const consent = consentRows.at(-1) ?? null;
    let consentOut = null;
    if (consent) {
      const answer = this.decrypt(consent.customerReplyEncrypted, consentAad(id));
      const expected =
        answer === null
          ? null
          : chainHash(consent.prevHash, {
              conversationId: id,
              textShownHash: consent.textShownHash,
              templateVersion: consent.templateVersion,
              customerReplyHash: sha256(answer),
              acceptedAt: consent.acceptedAt.toISOString(),
            });
      consentOut = {
        answer,
        at: consent.acceptedAt.toISOString(),
        legalTemplateVersion: consent.templateVersion,
        hash: consent.hash,
        chainVerified: expected !== null && expected === consent.hash,
      };
      events.push({ at: consent.acceptedAt.toISOString(), kind: 'CONSENT_RECORDED' });
    }
    for (const e of outbox) {
      const at = e.createdAt.toISOString();
      if (e.type === 'NeedsReview') {
        const reason = typeof e.payload.reason === 'string' ? e.payload.reason : undefined;
        events.push({ at, kind: 'SENT_TO_REVIEW', ...(reason ? { detail: reason } : {}) });
      } else if (e.type === 'TransferRequested') {
        if (e.payload.target === 'HUMAN') events.push({ at, kind: 'ESCALATED' });
        else if (!c.sale?.transferredAt) events.push({ at, kind: 'TRANSFER_REQUESTED' });
      } else if (e.type === 'ConversationClosed') {
        const kind =
          e.payload.reason === 'INACTIVE'
            ? 'CLOSED_INACTIVE'
            : e.payload.reason === 'SUPPORT'
              ? 'CLOSED_SUPPORT'
              : 'CLOSED_NO_SALE';
        events.push({ at, kind });
      }
    }
    if (c.sale?.transferredAt) {
      events.push({ at: c.sale.transferredAt.toISOString(), kind: 'TRANSFERRED' });
    }
    events.sort((a, b) => a.at.localeCompare(b.at));

    const inbound = messages.filter((m) => m.direction === 'INBOUND').length;
    const firstReply = messages.find(
      (m) => m.direction === 'OUTBOUND' && m.respondsToAt && m.sentAt,
    );
    const uncertainSends = Math.max(
      actions.filter((a) => a.result === 'UNCERTAIN').length,
      messages.filter((m) => m.status === 'UNCERTAIN').length,
    );
    const regenerations = llmCalls.filter((l) =>
      ['REGENERATED', 'FALLBACK'].includes(l.validationResult),
    ).length;
    const reviewed = c.status === 'NEEDS_REVIEW' || outbox.some((e) => e.type === 'NeedsReview');
    const flags: TraceFlag[] = [];
    if (uncertainSends) flags.push('UNCERTAIN_SEND');
    if (reviewed) flags.push('REVIEW');
    if (regenerations) flags.push('REGENERATED');
    const process = (c.sale?.process ?? profile.process ?? null) as Process | null;

    let nav: { index: number; total: number; prevId: string | null; nextId: string | null } | null =
      null;
    if (f) {
      // Si el filtro ya no se puede armar (p. ej. supera el tope), el detalle sale sin flechas.
      const rows = await this.filtered(f).catch(() => [] as Row[]);
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) {
        nav = {
          index: i + 1,
          total: rows.length,
          prevId: rows[i - 1]?.id ?? null,
          nextId: rows[i + 1]?.id ?? null,
        };
      }
    }

    await this.auditView(actor, c.abayaChatId, id);

    return {
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      updatedAt: closed ? c.updatedAt.toISOString() : null,
      closed,
      robotUser: c.robotUser,
      abayaChatId: c.abayaChatId,
      customerName: profile.name?.trim() || null,
      status: c.status,
      stage: c.stage,
      process: PROCESSES.includes(process as Process) ? process : null,
      planCode: c.sale?.planCode ?? null,
      inbound,
      outbound: messages.length - inbound,
      firstResponseMs:
        firstReply?.sentAt && firstReply.respondsToAt
          ? Math.max(0, firstReply.sentAt.getTime() - firstReply.respondsToAt.getTime())
          : null,
      durationMs: closed ? Math.max(0, c.updatedAt.getTime() - c.createdAt.getTime()) : null,
      flags,
      contentPurged: !!c.contentPurgedAt,
      contentPurgedAt: iso(c.contentPurgedAt),
      agentVersion: c.agentVersionId
        ? ((await this.versionNumbers([c.agentVersionId])).get(c.agentVersionId) ?? null)
        : null,
      stagePath: stagePath(
        llmCalls.map((l) => l.stage),
        c.stage,
      ),
      messages: traceMessages,
      events,
      profile: {
        name: profile.name?.trim() || null,
        currentOperator: profile.currentOperator?.trim() || null,
        declaredUse: profile.usage?.trim() || null,
        process: PROCESSES.includes(profile.process as Process)
          ? (profile.process as Process)
          : null,
      },
      sale: c.sale
        ? {
            planCode: c.sale.planCode,
            backofficeSummary: this.decrypt(c.sale.summaryEncrypted, saleAad(id)),
            transferredAt: iso(c.sale.transferredAt),
            internalNoteOk: c.sale.backofficeNoteOk,
          }
        : null,
      consent: consentOut,
      brainVersion: lastUsage ? `v${lastUsage.brainVersion}` : null,
      knowledgeUsage,
      llmCalls: llmCalls.map((l) => ({
        at: l.createdAt.toISOString(),
        stage: l.stage,
        provider: l.provider,
        model: l.model,
        latencyMs: l.latencyMs,
        tokens: l.inputTokens + l.outputTokens,
        result:
          l.validationResult === 'OK'
            ? 'VALIDATED'
            : l.validationResult === 'REGENERATED'
              ? 'REGENERATED'
              : l.validationResult === 'FALLBACK'
                ? 'SAFE_REPLY'
                : 'ERROR',
      })),
      rpaActions: actions.map((a) => ({
        at: a.createdAt.toISOString(),
        action: a.action,
        result: a.result,
        durationMs: a.durationMs,
        traceRef: a.traceRef,
      })),
      nav,
    };
  }

  // ---------------------------------------------------------------- exportar

  /** CSV del filtro, SIN el texto de los mensajes. Queda en Auditoría con los filtros. */
  async exportCsv(f: ConversationFilters, actor: string): Promise<string> {
    const rows = await this.filtered(f);
    const header = [
      'inicio',
      'fin',
      'robot',
      'chat_abaya',
      'cliente',
      'tipificacion',
      'etapa_final',
      'proceso',
      'plan',
      'mensajes_entrantes',
      'mensajes_salientes',
      'primera_respuesta_ms',
      'duracion_ms',
      'alertas',
      'version_guion',
    ];
    const lines = rows.map((r) =>
      [
        r.createdAt,
        r.updatedAt ?? '',
        r.robotUser,
        r.abayaChatId,
        r.customerName ?? '',
        r.status,
        r.stage,
        r.process ?? '',
        r.planCode ?? '',
        r.inbound,
        r.outbound,
        r.firstResponseMs ?? '',
        r.durationMs ?? '',
        r.flags.join('|'),
        r.agentVersion ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    await this.prisma.adminAuditLog.create({
      data: {
        actor: actor.slice(0, 60),
        action: 'CONVERSATIONS_EXPORTED',
        target: `${rows.length} conversaciones`,
        detail: filtersDetail(f) as Prisma.InputJsonValue,
      },
    });
    return '﻿' + [header.join(','), ...lines].join('\r\n') + '\r\n';
  }

  /** Transcripción completa de una conversación (texto plano). Queda en Auditoría. */
  async transcript(id: string, actor: string): Promise<{ name: string; text: string }> {
    const c = await this.prisma.conversation.findUnique({ where: { id } });
    if (!c) throw new ConversationsError(404, 'Conversación no encontrada');
    const messages = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    });
    const profile = this.profile(c.id, c.profileEncrypted);
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(d);
    const lines = [
      `Conversación ${c.abayaChatId} · robot ${c.robotUser}`,
      `Cliente: ${profile.name?.trim() || '—'} · Tipificación: ${c.status} · Etapa final: ${c.stage}`,
      `Inicio: ${fmt(c.createdAt)} (hora de Bogotá)`,
      ...(c.contentPurgedAt
        ? [`Contenido borrado por retención el ${fmt(c.contentPurgedAt)}`]
        : []),
      '',
      ...messages.map((m) => {
        const bot = m.direction === 'OUTBOUND';
        const at = bot ? (m.sentAt ?? m.occurredAt) : m.occurredAt;
        return `[${fmt(at)}] ${bot ? 'Robot' : 'Cliente'}: ${this.body(m) ?? '(no se pudo descifrar)'}`;
      }),
    ];
    await this.prisma.adminAuditLog.create({
      data: {
        actor: actor.slice(0, 60),
        action: 'CONVERSATIONS_EXPORTED',
        target: c.abayaChatId,
        detail: { transcript: true, conversationId: id },
      },
    });
    return { name: `transcripcion-${c.abayaChatId}.txt`, text: '﻿' + lines.join('\r\n') + '\r\n' };
  }

  // ---------------------------------------------------------------- utilidades

  /** Id(s) de una versión del agente por número (la v1 del código no está en la base). */
  private async versionIds(version: number): Promise<string[]> {
    const rows = await this.prisma.agentConfigVersion.findMany({
      where: { version },
      select: { id: true },
    });
    return [...rows.map((r) => r.id), ...(version === 1 ? [DEFAULT_AGENT_CONFIG.id] : [])];
  }

  private async versionNumbers(ids: (string | null)[]): Promise<Map<string, number>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    const out = new Map<string, number>();
    if (unique.includes(DEFAULT_AGENT_CONFIG.id))
      out.set(DEFAULT_AGENT_CONFIG.id, DEFAULT_AGENT_CONFIG.version);
    if (!unique.length) return out;
    const rows = await this.prisma.agentConfigVersion.findMany({
      where: { id: { in: unique } },
      select: { id: true, version: true },
    });
    for (const r of rows) out.set(r.id, r.version);
    return out;
  }

  private async auditView(actor: string, chatId: string, id: string) {
    const since = new Date(this.now().getTime() - VIEW_AUDIT_WINDOW_MS);
    const recent = await this.prisma.adminAuditLog.findFirst({
      where: { actor, action: 'CONVERSATION_VIEWED', target: chatId, createdAt: { gte: since } },
      select: { id: true },
    });
    if (recent) return;
    await this.prisma.adminAuditLog.create({
      data: {
        actor: actor.slice(0, 60),
        action: 'CONVERSATION_VIEWED',
        target: chatId,
        detail: { conversationId: id },
      },
    });
  }

  private profile(id: string, enc: Uint8Array | null): Profile {
    if (!enc) return {};
    const raw = this.decrypt(enc, profileAad(id));
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Profile;
    } catch {
      return {};
    }
  }

  private body(m: {
    direction: string;
    fingerprint: string | null;
    idempotencyKey: string | null;
    bodyEncrypted: Uint8Array;
  }): string | null {
    const aad =
      m.direction === 'INBOUND'
        ? inboundAad(m.fingerprint ?? '')
        : outboundAad(m.idempotencyKey ?? '');
    return this.decrypt(m.bodyEncrypted, aad);
  }

  /** Descifra; null si el contenido se borró por retención o no se puede descifrar. */
  private decrypt(enc: Uint8Array, aad: string): string | null {
    if (!enc.length) return null;
    try {
      return this.cipher.decryptString(enc, aad);
    } catch {
      return null;
    }
  }
}

/**
 * Recorrido aproximado: hoy no se guarda el historial de etapas, así que se arma con las etapas
 * de las llamadas al modelo (en orden) y la etapa final. Las etapas sin llamada (MENU con plantilla,
 * AUTORIZACION determinista) pueden faltar en medio. Ver «datos faltantes» en D-002.
 */
export function stagePath(llmStages: string[], finalStage: string): string[] {
  const seq = ['MENU', ...llmStages, finalStage];
  return seq.filter((s, i) => i === 0 || s !== seq[i - 1]);
}

function csvCell(v: string | number): string {
  const s = String(v);
  // Evita que una hoja de cálculo interprete el contenido como fórmula.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function filtersDetail(f: ConversationFilters) {
  return {
    range: f.range,
    from: f.from.toISOString(),
    to: f.to.toISOString(),
    ...(f.robots.length ? { robots: f.robots } : {}),
    ...(f.statuses.length ? { statuses: f.statuses } : {}),
    ...(f.processes.length ? { processes: f.processes } : {}),
    ...(f.stages.length ? { stages: f.stages } : {}),
    ...(f.reviewed !== undefined ? { reviewed: f.reviewed } : {}),
    ...(f.agentVersion !== undefined ? { agentVersion: f.agentVersion } : {}),
    ...(f.q ? { q: f.q } : {}),
  };
}
