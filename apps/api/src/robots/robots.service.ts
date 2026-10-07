import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  Prisma,
  openChatsByRobot,
  responseTimeByRobot,
  utcParam as utc,
  type PrismaClient,
  type Robot,
} from '@abaya/db';
import { base32Decode, type FieldCipher } from '@abaya/crypto';
import { robotPauseKey, type AlertPort } from '@abaya/domain';
import { startOfBogotaDay } from '../admin/admin.service.js';
import { ServiceError } from '../admin/errors.js';
import type { FlagStore } from '../admin/flags.js';
import type { ReleaseService } from './release.service.js';
import type { RobotAccessTokens } from './robot-tokens.js';

/** Código de instalación: un solo uso, vence en 24 h (sección 2.6). */
export const ENROLLMENT_TTL_MS = 24 * 3_600_000;
/** Igual que en el rpa: sin presencia por más de esto, el robot está "sin señal". */
export const ONLINE_WINDOW_MS = 60_000;

const ROBOT_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,59}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type RobotStatus =
  'EN_LINEA' | 'RECONECTANDO' | 'CAIDO' | 'SIN_SENAL' | 'APAGADO' | 'DESHABILITADO';

export type Range = 'hoy' | '7d' | '30d';
export const RANGES: readonly Range[] = ['hoy', '7d', '30d'];

/** Lo que el padre entrega a cada hijo al arrancar (además de sus credenciales de Abaya). */
export interface ChildSettings {
  nodeEnv: string;
  abayaBaseUrl?: string;
  heartbeatMs: number;
}

/**
 * Tras rotar, el token anterior se acepta solo durante esta ventana y solo para reintentar
 * (la respuesta pudo perderse). Después, presentarlo es reúso: posible robo (v1.6).
 */
export const ROTATION_GRACE_MS = 60_000;
/** Cuánto se guarda en memoria la verificación de un robot (habilitado y versión de tokens). */
const AUTH_CACHE_MS = 5_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normalizeCode = (raw: unknown) =>
  typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
const str = (raw: unknown) => (typeof raw === 'string' ? raw : '');

function enrollmentCode(): string {
  let c = '';
  for (let i = 0; i < 12; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

export function robotStatus(
  r: Pick<Robot, 'enabled' | 'state' | 'lastSeenAt'> | null,
  sessionStatus: string | undefined,
  now: Date,
): RobotStatus {
  if (r && !r.enabled) return 'DESHABILITADO';
  if (!r || r.state === 'STOPPED' || !r.lastSeenAt) return 'APAGADO';
  if (now.getTime() - r.lastSeenAt.getTime() > ONLINE_WINDOW_MS) return 'SIN_SENAL';
  if (sessionStatus === 'DOWN') return 'CAIDO';
  if (sessionStatus === 'RELOGGING') return 'RECONECTANDO';
  return 'EN_LINEA';
}

export function rangeStart(range: Range, now: Date): Date {
  if (range === 'hoy') return startOfBogotaDay(now);
  return new Date(now.getTime() - (range === '7d' ? 7 : 30) * 24 * 3_600_000);
}

export function parseRange(raw: unknown): Range {
  return RANGES.includes(raw as Range) ? (raw as Range) : 'hoy';
}

interface ActionRow {
  robotUser: string;
  action: string;
  total: number;
  ok: number;
  errors: number;
  uncertain: number;
  blocked: number;
  p50: number | null;
  p95: number | null;
}

/**
 * Registro de robots hijos (v1.4, sección 2.6): alta con credenciales cifradas, códigos de
 * instalación de un solo uso, configuración para cada hijo, pausa y rendimiento por equipo.
 * Las credenciales de Abaya nunca se devuelven al panel ni se registran.
 */
export class RobotsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly flags: FlagStore,
    private readonly cipher: FieldCipher,
    private readonly child: ChildSettings,
    opts: {
      now?: () => Date;
      maxChatsPerRobot?: number;
      tokens?: RobotAccessTokens;
      alerts?: AlertPort;
      release?: ReleaseService;
    } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.maxChatsPerRobot = opts.maxChatsPerRobot ?? 3;
    this.tokens = opts.tokens;
    this.alerts = opts.alerts;
    this.release = opts.release;
  }

  private readonly now: () => Date;
  private readonly tokens?: RobotAccessTokens;
  private readonly alerts?: AlertPort;
  private readonly release?: ReleaseService;
  private readonly authCache = new Map<string, { ok: boolean; v: number; at: number }>();
  /** Tope de chats simultáneos por robot (v1.5): el panel resalta a quien lo supera. */
  readonly maxChatsPerRobot: number;

  // ---------- Gestión (ADMIN) ----------

  async create(
    actor: string,
    input: {
      robotUser?: unknown;
      abayaPassword?: unknown;
      mfaMode?: unknown;
      totpSecret?: unknown;
    },
  ) {
    const robotUser = str(input.robotUser).trim();
    if (!ROBOT_USER_RE.test(robotUser)) {
      throw new ServiceError(
        400,
        'Usuario robot inválido: 3 a 60 caracteres (letras, números, punto, guion o guion bajo)',
      );
    }
    const creds = this.credentials(robotUser, input, true);
    const existing = await this.prisma.robot.findUnique({ where: { robotUser } });
    if (existing?.abayaPasswordEncrypted || existing?.agentTokenHash) {
      throw new ServiceError(409, 'Ese robot ya existe');
    }
    const code = enrollmentCode();
    const data = {
      ...creds,
      enrollmentCodeHash: sha256(normalizeCode(code)),
      enrollmentExpiresAt: new Date(this.now().getTime() + ENROLLMENT_TTL_MS),
      createdBy: actor,
    };
    // Si ya corrió en modo .env (desarrollo) queda registrado sin credenciales: se completa.
    await this.prisma.robot.upsert({
      where: { robotUser },
      create: { robotUser, ...data },
      update: data,
    });
    await this.audit(actor, 'ROBOT_CREATED', robotUser);
    return { robotUser, enrollmentCode: code, expiresAt: data.enrollmentExpiresAt };
  }

  async updateCredentials(
    actor: string,
    robotUser: string,
    input: { abayaPassword?: unknown; mfaMode?: unknown; totpSecret?: unknown },
  ) {
    await this.get(robotUser);
    await this.prisma.robot.update({
      where: { robotUser },
      data: this.credentials(robotUser, input, false),
    });
    await this.audit(actor, 'ROBOT_CREDENTIALS_CHANGED', robotUser);
    return { ok: true, note: 'El robot usará las credenciales nuevas en su próximo arranque.' };
  }

  /** Nuevo código para instalar en un equipo (primera vez, reinstalación o cambio de equipo). */
  async newEnrollmentCode(actor: string, robotUser: string) {
    const robot = await this.get(robotUser);
    if (!robot.enabled) throw new ServiceError(409, 'El robot está deshabilitado');
    if (!robot.abayaPasswordEncrypted) {
      throw new ServiceError(409, 'Primero registre la contraseña de Abaya del robot');
    }
    const code = enrollmentCode();
    const expiresAt = new Date(this.now().getTime() + ENROLLMENT_TTL_MS);
    await this.prisma.robot.update({
      where: { robotUser },
      data: { enrollmentCodeHash: sha256(normalizeCode(code)), enrollmentExpiresAt: expiresAt },
    });
    await this.audit(actor, 'ROBOT_ENROLLMENT_CODE', robotUser);
    return { robotUser, enrollmentCode: code, expiresAt };
  }

  async setPaused(actor: string, robotUser: string, paused: unknown) {
    if (typeof paused !== 'boolean') throw new ServiceError(400, 'paused debe ser booleano');
    await this.get(robotUser);
    // Primero la bandera (la revisa el robot antes de cada acción), luego el registro.
    await this.flags.set(robotPauseKey(robotUser), paused ? '1' : '0');
    await this.prisma.robot.update({ where: { robotUser }, data: { paused } });
    await this.audit(actor, paused ? 'ROBOT_PAUSED' : 'ROBOT_RESUMED', robotUser);
    return { robotUser, paused };
  }

  /** Deshabilitar revoca la instalación: el equipo en marcha se apaga en su siguiente presencia. */
  async setEnabled(actor: string, robotUser: string, enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new ServiceError(400, 'enabled debe ser booleano');
    await this.get(robotUser);
    await this.prisma.robot.update({
      where: { robotUser },
      data: enabled
        ? { enabled: true }
        : {
            enabled: false,
            agentTokenHash: null,
            previousTokenHash: null,
            enrollmentCodeHash: null,
            enrollmentExpiresAt: null,
            // Invalida al instante todos los tokens de acceso emitidos.
            tokenVersion: { increment: 1 },
          },
    });
    this.authCache.delete(robotUser);
    await this.audit(actor, enabled ? 'ROBOT_ENABLED' : 'ROBOT_DISABLED', robotUser);
    return {
      robotUser,
      enabled,
      ...(enabled ? { note: 'Genere un código nuevo para volver a instalarlo en un equipo.' } : {}),
    };
  }

  // ---------- Actualizaciones (v1.7, sección 2.9) ----------

  /** Pide al robot instalar la versión publicada cuando esté libre (bandeja vacía). */
  async requestUpdate(actor: string, robotUser: string) {
    const target = this.release?.installable();
    if (!target) {
      throw new ServiceError(409, 'No hay una versión publicada con firma válida en el servidor');
    }
    const robot = await this.get(robotUser);
    if (!robot.enabled) throw new ServiceError(409, 'El robot está deshabilitado');
    if (robot.version === target) throw new ServiceError(409, 'El robot ya tiene esa versión');
    await this.prisma.robot.update({
      where: { robotUser },
      data: {
        updateRequested: true,
        updateStatus: 'PENDING',
        updateVersion: target,
        updateMessage: null,
        updateAt: this.now(),
      },
    });
    await this.audit(actor, 'ROBOT_UPDATE_REQUESTED', `${robotUser}:${target}`);
    return { robotUser, version: target };
  }

  /** Todos los robots habilitados que no tienen la versión publicada. */
  async requestUpdateAll(actor: string) {
    const target = this.release?.installable();
    if (!target) {
      throw new ServiceError(409, 'No hay una versión publicada con firma válida en el servidor');
    }
    const r = await this.prisma.robot.updateMany({
      where: { enabled: true, NOT: { version: target } },
      data: {
        updateRequested: true,
        updateStatus: 'PENDING',
        updateVersion: target,
        updateMessage: null,
        updateAt: this.now(),
      },
    });
    await this.audit(actor, 'ROBOT_UPDATE_REQUESTED', `todos:${target}:${r.count}`);
    return { version: target, robots: r.count };
  }

  async cancelUpdate(actor: string, robotUser: string) {
    await this.get(robotUser);
    await this.prisma.robot.update({
      where: { robotUser },
      data: { updateRequested: false, updateStatus: null, updateMessage: null },
    });
    await this.audit(actor, 'ROBOT_UPDATE_CANCELLED', robotUser);
    return { robotUser, cancelled: true };
  }

  publishedRelease() {
    const p = this.release?.published();
    return p
      ? { version: p.version, size: p.size, builtAt: p.builtAt, signatureValid: p.signatureValid }
      : null;
  }

  // ---------- Hijos (sin sesión de panel) ----------

  /** Cambia un código de instalación válido por el token del equipo. */
  async enroll(rawCode: unknown, rawHost: unknown) {
    const code = normalizeCode(rawCode);
    const host =
      str(rawHost)
        .replace(/[^\w.-]/g, '_')
        .slice(0, 64) || 'desconocido';
    const robot = code
      ? await this.prisma.robot.findUnique({ where: { enrollmentCodeHash: sha256(code) } })
      : null;
    const now = this.now();
    if (!robot || !robot.enabled || !robot.enrollmentExpiresAt || robot.enrollmentExpiresAt < now) {
      throw new ServiceError(400, 'Código de instalación inválido o vencido');
    }
    const token = randomBytes(32).toString('base64url');
    // Un solo uso: solo gana quien todavía encuentra el código.
    const r = await this.prisma.robot.updateMany({
      where: { robotUser: robot.robotUser, enrollmentCodeHash: sha256(code) },
      data: {
        agentTokenHash: sha256(token),
        previousTokenHash: null,
        tokenRotatedAt: now,
        // Reinstalar invalida los accesos del equipo anterior.
        tokenVersion: { increment: 1 },
        enrolledAt: now,
        enrollmentCodeHash: null,
        enrollmentExpiresAt: null,
      },
    });
    this.authCache.delete(robot.robotUser);
    if (r.count !== 1) throw new ServiceError(400, 'Código de instalación inválido o vencido');
    await this.audit(`equipo:${host}`, 'ROBOT_ENROLLED', robot.robotUser);
    return { robotUser: robot.robotUser, token };
  }

  /**
   * Renovación (v1.6): cambia el token de renovación del equipo por un token de acceso de 1 h y
   * un token de renovación NUEVO (rotación). El anterior solo vale para reintentar durante
   * `ROTATION_GRACE_MS`; después, presentarlo es reúso (copia del archivo, robo): se revocan
   * todos los tokens del robot y se alerta.
   */
  async refresh(rawToken: unknown) {
    if (!this.tokens) throw new ServiceError(503, 'Pasarela de robots no configurada');
    const token = str(rawToken);
    if (token.length < 32 || token.length > 200) {
      throw new ServiceError(401, 'Instalación no válida o revocada');
    }
    const hash = sha256(token);
    const now = this.now();
    const current = await this.prisma.robot.findUnique({ where: { agentTokenHash: hash } });
    if (current) return this.rotate(current, hash, now);

    const previous = await this.prisma.robot.findUnique({ where: { previousTokenHash: hash } });
    if (!previous) throw new ServiceError(401, 'Instalación no válida o revocada');
    const inGrace =
      previous.tokenRotatedAt &&
      now.getTime() - previous.tokenRotatedAt.getTime() < ROTATION_GRACE_MS;
    if (inGrace) {
      // La respuesta de la rotación se perdió: se vuelve a rotar desde el token anterior.
      return this.rotate(previous, previous.agentTokenHash, now, hash);
    }
    await this.prisma.robot.update({
      where: { robotUser: previous.robotUser },
      data: { agentTokenHash: null, previousTokenHash: null, tokenVersion: { increment: 1 } },
    });
    this.authCache.delete(previous.robotUser);
    await this.audit('pasarela', 'ROBOT_TOKEN_REUSE', previous.robotUser);
    await this.alerts?.raise('ROBOT_TOKEN_REUSE', 'CRITICA', { robotUser: previous.robotUser });
    throw new ServiceError(401, 'Instalación revocada: genere un código nuevo y reinstale');
  }

  private async rotate(
    robot: Robot,
    expectedHash: string | null,
    now: Date,
    previousHash?: string,
  ) {
    if (!robot.enabled) throw new ServiceError(403, 'El robot está deshabilitado');
    const next = randomBytes(32).toString('base64url');
    // Condicional: si dos renovaciones compiten, solo una rota (la otra recibe 401).
    const r = await this.prisma.robot.updateMany({
      where: { robotUser: robot.robotUser, agentTokenHash: expectedHash },
      data: {
        agentTokenHash: sha256(next),
        previousTokenHash: previousHash ?? expectedHash,
        tokenRotatedAt: now,
      },
    });
    if (r.count !== 1) throw new ServiceError(401, 'Instalación no válida o revocada');
    const access = this.tokens!.issue(robot.robotUser, robot.tokenVersion);
    return {
      robotUser: robot.robotUser,
      accessToken: access.token,
      expiresAt: new Date(access.expiresAt).toISOString(),
      refreshToken: next,
    };
  }

  /** Robot de un token de acceso válido, vigente y de un robot habilitado; si no, 401. */
  async authenticate(authorization: string | undefined): Promise<string> {
    return (await this.verifyAccess(authorization)).robotUser;
  }

  async verifyAccess(
    authorization: string | undefined,
  ): Promise<{ robotUser: string; version: number }> {
    const claims = this.tokens?.verify(
      authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined,
    );
    if (!claims) throw new ServiceError(401, 'Token de acceso no válido o vencido');
    if (!(await this.isAccessValid(claims.r, claims.v))) {
      throw new ServiceError(401, 'Instalación no válida o revocada');
    }
    return { robotUser: claims.r, version: claims.v };
  }

  /**
   * ¿Sigue habilitado el robot y vigente esa versión de tokens? Lo revisa la pasarela en cada
   * petición y cada 15 s en las conexiones abiertas (deshabilitar o revocar corta al instante).
   * El vencimiento del token NO corta una conexión ya abierta: el robot renueva en segundo plano.
   */
  async isAccessValid(robotUser: string, version: number): Promise<boolean> {
    const t = Date.now();
    let cached = this.authCache.get(robotUser);
    if (!cached || t - cached.at > AUTH_CACHE_MS) {
      const robot = await this.prisma.robot.findUnique({
        where: { robotUser },
        select: { enabled: true, tokenVersion: true, agentTokenHash: true },
      });
      cached = {
        ok: !!robot?.enabled && !!robot.agentTokenHash,
        v: robot?.tokenVersion ?? -1,
        at: t,
      };
      this.authCache.set(robotUser, cached);
    }
    return cached.ok && cached.v === version;
  }

  /** Lo único que el equipo necesita para Abaya: nada de base de datos, Redis ni claves (v1.6). */
  async robotConfig(robotUser: string) {
    const robot = await this.get(robotUser);
    if (!robot.abayaPasswordEncrypted) {
      throw new ServiceError(409, 'El robot no tiene contraseña de Abaya registrada');
    }
    if (!this.child.abayaBaseUrl) {
      throw new ServiceError(503, 'ABAYA_BASE_URL no está configurada en el servidor');
    }
    const aad = this.aad(robot.robotUser);
    const decrypt = (v: Uint8Array) => {
      try {
        return this.cipher.decryptString(v, aad);
      } catch {
        throw new ServiceError(
          409,
          'No se pudieron leer las credenciales del robot: vuelva a registrarlas en el panel',
        );
      }
    };
    return {
      nodeEnv: this.child.nodeEnv,
      abayaBaseUrl: this.child.abayaBaseUrl,
      robotUser: robot.robotUser,
      password: decrypt(robot.abayaPasswordEncrypted),
      mfaMode: robot.mfaMode as 'none' | 'totp',
      ...(robot.totpSecretEncrypted ? { totpSecret: decrypt(robot.totpSecretEncrypted) } : {}),
      heartbeatMs: this.child.heartbeatMs,
    };
  }

  // ---------- Consulta (ambos roles) ----------

  /** Todos los robots con su estado y rendimiento en el rango (comparación por equipo). */
  async list(range: Range) {
    const now = this.now();
    const from = rangeStart(range, now);
    const [robots, sessions, convs, sales, actions, openChats, responses] = await Promise.all([
      this.prisma.robot.findMany(),
      this.prisma.rpaSession.findMany(),
      this.prisma.conversation.groupBy({
        by: ['robotUser', 'status'],
        where: { createdAt: { gte: from } },
        _count: { _all: true },
      }),
      this.salesByRobot(from),
      this.actionStats(from),
      openChatsByRobot(this.prisma),
      responseTimeByRobot(this.prisma, from),
    ]);
    const users = [
      ...new Set([...robots.map((r) => r.robotUser), ...sessions.map((s) => s.robotUser)]),
    ].sort();
    return {
      range,
      from,
      generatedAt: now,
      maxChatsPerRobot: this.maxChatsPerRobot,
      published: this.publishedRelease(),
      robots: users.map((u) => {
        const robot = robots.find((r) => r.robotUser === u) ?? null;
        const session = sessions.find((s) => s.robotUser === u);
        const byStatus = Object.fromEntries(
          convs.filter((c) => c.robotUser === u).map((c) => [c.status, c._count._all]),
        );
        const conversations = Object.values(byStatus).reduce((a, b) => a + b, 0);
        const sale = sales.find((s) => s.robotUser === u);
        const acts = actions.filter((a) => a.robotUser === u);
        const send = acts.find((a) => a.action === 'SEND');
        const rt = responses.find((r) => r.robotUser === u);
        return {
          ...this.summary(u, robot, session, now),
          openChats: openChats.get(u) ?? 0,
          metrics: {
            responseP50Ms: rt?.p50Ms ?? null,
            responseP95Ms: rt?.p95Ms ?? null,
            responses: rt?.samples ?? 0,
            conversations,
            sales: sale?.sales ?? 0,
            transferred: sale?.transferred ?? 0,
            conversionPct: conversations
              ? Math.round((1000 * (sale?.sales ?? 0)) / conversations) / 10
              : null,
            needsReview: byStatus.NEEDS_REVIEW ?? 0,
            actions: acts.reduce((a, x) => a + x.total, 0),
            errors: acts.reduce((a, x) => a + x.errors, 0),
            uncertain: acts.reduce((a, x) => a + x.uncertain, 0),
            sendP95Ms: send?.p95 ?? null,
          },
        };
      }),
    };
  }

  /** Un robot: estado, rendimiento por acción, cierres por motivo e historial reciente. */
  async detail(robotUser: string, range: Range) {
    const now = this.now();
    const from = rangeStart(range, now);
    const [robot, session] = await Promise.all([
      this.prisma.robot.findUnique({ where: { robotUser } }),
      this.prisma.rpaSession.findUnique({ where: { robotUser } }),
    ]);
    if (!robot && !session) throw new ServiceError(404, 'Robot no encontrado');
    const [convs, sales, actions, recent, openChats, responses] = await Promise.all([
      this.prisma.conversation.groupBy({
        by: ['status'],
        where: { robotUser, createdAt: { gte: from } },
        _count: { _all: true },
      }),
      this.salesByRobot(from, robotUser),
      this.actionStats(from, robotUser),
      this.prisma.rpaActionLog.findMany({
        where: { robotUser },
        orderBy: { seq: 'desc' },
        take: 100,
        select: {
          createdAt: true,
          action: true,
          abayaChatId: true,
          result: true,
          durationMs: true,
        },
      }),
      openChatsByRobot(this.prisma),
      responseTimeByRobot(this.prisma, from, robotUser),
    ]);
    const rt = responses[0];
    const byStatus = Object.fromEntries(convs.map((c) => [c.status, c._count._all]));
    const conversations = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const sale = sales[0];
    return {
      range,
      from,
      generatedAt: now,
      robot: this.summary(robotUser, robot, session ?? undefined, now),
      openChats: openChats.get(robotUser) ?? 0,
      maxChatsPerRobot: this.maxChatsPerRobot,
      response: {
        samples: rt?.samples ?? 0,
        p50Ms: rt?.p50Ms ?? null,
        p95Ms: rt?.p95Ms ?? null,
        maxMs: rt?.maxMs ?? null,
      },
      session: session
        ? {
            status: session.status,
            lastHeartbeat: session.lastHeartbeat,
            lastLoginAt: session.lastLoginAt,
            consecutiveFails: session.consecutiveFails,
          }
        : null,
      metrics: {
        conversations,
        byStatus,
        sales: sale?.sales ?? 0,
        transferred: sale?.transferred ?? 0,
        conversionPct: conversations
          ? Math.round((1000 * (sale?.sales ?? 0)) / conversations) / 10
          : null,
      },
      actions: actions.map(({ robotUser: _r, ...a }) => a),
      recentActions: recent,
    };
  }

  // ---------- Internos ----------

  private summary(
    robotUser: string,
    robot: Robot | null,
    session: { status: string } | undefined,
    now: Date,
  ) {
    return {
      robotUser,
      status: robotStatus(robot, session?.status, now),
      sessionStatus: session?.status ?? null,
      paused: robot?.paused ?? false,
      enabled: robot?.enabled ?? true,
      host: robot?.host ?? null,
      version: robot?.version ?? null,
      startedAt: robot?.startedAt ?? null,
      lastSeenAt: robot?.lastSeenAt ?? null,
      stoppedAt: robot?.stoppedAt ?? null,
      installed: !!robot?.agentTokenHash,
      enrolledAt: robot?.enrolledAt ?? null,
      pendingCodeUntil:
        robot?.enrollmentExpiresAt && robot.enrollmentExpiresAt > now
          ? robot.enrollmentExpiresAt
          : null,
      hasCredentials: !!robot?.abayaPasswordEncrypted,
      mfaMode: robot?.mfaMode ?? 'none',
      lastRejectedHost: robot?.lastRejectedHost ?? null,
      lastRejectedAt: robot?.lastRejectedAt ?? null,
      update: robot?.updateStatus
        ? {
            requested: robot.updateRequested,
            status: robot.updateStatus,
            version: robot.updateVersion,
            message: robot.updateMessage,
            at: robot.updateAt,
          }
        : null,
    };
  }

  private async salesByRobot(from: Date, robotUser?: string) {
    return this.prisma.$queryRaw<{ robotUser: string; sales: number; transferred: number }[]>`
      SELECT c."robotUser" AS "robotUser",
             count(*)::int AS sales,
             count(s."transferredAt")::int AS transferred
      FROM "Sale" s JOIN "Conversation" c ON c.id = s."conversationId"
      WHERE s."createdAt" >= ${utc(from)}
        ${robotUser ? Prisma.sql`AND c."robotUser" = ${robotUser}` : Prisma.empty}
      GROUP BY c."robotUser"`;
  }

  private async actionStats(from: Date, robotUser?: string): Promise<ActionRow[]> {
    const rows = await this.prisma.$queryRaw<ActionRow[]>`
      SELECT "robotUser", action,
             count(*)::int AS total,
             count(*) FILTER (WHERE result = 'OK')::int AS ok,
             count(*) FILTER (WHERE result = 'ERROR')::int AS errors,
             count(*) FILTER (WHERE result = 'UNCERTAIN')::int AS uncertain,
             count(*) FILTER (WHERE result = 'BLOCKED')::int AS blocked,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs") AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95
      FROM "RpaActionLog"
      WHERE "createdAt" >= ${utc(from)}
        ${robotUser ? Prisma.sql`AND "robotUser" = ${robotUser}` : Prisma.empty}
      GROUP BY "robotUser", action
      ORDER BY "robotUser", action`;
    return rows.map((r) => ({
      ...r,
      p50: r.p50 === null ? null : Math.round(Number(r.p50)),
      p95: r.p95 === null ? null : Math.round(Number(r.p95)),
    }));
  }

  /** Valida y cifra las credenciales de Abaya (AAD = robot: no sirven para otro robot). */
  private credentials(
    robotUser: string,
    input: { abayaPassword?: unknown; mfaMode?: unknown; totpSecret?: unknown },
    creating: boolean,
  ) {
    const aad = this.aad(robotUser);
    const data: {
      abayaPasswordEncrypted?: Uint8Array<ArrayBuffer>;
      mfaMode?: string;
      totpSecretEncrypted?: Uint8Array<ArrayBuffer> | null;
    } = {};
    const password = str(input.abayaPassword);
    if (password.length > 200) throw new ServiceError(400, 'Contraseña de Abaya demasiado larga');
    if (password) data.abayaPasswordEncrypted = new Uint8Array(this.cipher.encrypt(password, aad));
    else if (creating) throw new ServiceError(400, 'Falta la contraseña de Abaya del robot');

    const mfa = input.mfaMode === undefined && creating ? 'none' : input.mfaMode;
    if (mfa !== undefined) {
      if (mfa !== 'none' && mfa !== 'totp') {
        throw new ServiceError(400, 'MFA inválido: use none o totp');
      }
      data.mfaMode = mfa;
      if (mfa === 'none') {
        data.totpSecretEncrypted = null;
      } else {
        const secret = str(input.totpSecret).replace(/\s/g, '');
        try {
          if (base32Decode(secret).length < 10) throw new Error('corto');
        } catch {
          throw new ServiceError(400, 'Secreto TOTP inválido (base32)');
        }
        data.totpSecretEncrypted = new Uint8Array(this.cipher.encrypt(secret, aad));
      }
    }
    if (!Object.keys(data).length) throw new ServiceError(400, 'Nada que cambiar');
    return data;
  }

  private aad(robotUser: string) {
    return `robot:${robotUser}`;
  }

  private async get(robotUser: string): Promise<Robot> {
    const robot = await this.prisma.robot.findUnique({ where: { robotUser } });
    if (!robot) throw new ServiceError(404, 'Robot no encontrado');
    return robot;
  }

  /** Auditoría desde los controladores (p. ej. descarga de trazas). */
  recordAudit(actor: string, action: string, target?: string) {
    return this.audit(actor, action, target);
  }

  private async audit(actor: string, action: string, target?: string) {
    await this.prisma.adminAuditLog.create({
      data: { actor: actor.slice(0, 60), action, target: target ?? null },
    });
  }
}
