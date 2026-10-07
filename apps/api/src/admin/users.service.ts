import { createHash, randomBytes } from 'node:crypto';
import { withSerializableRetry, type AdminRole, type PrismaClient } from '@abaya/db';
import {
  DUMMY_PASSWORD_HASH,
  generateTemporaryPassword,
  hashPassword,
  passwordIssues,
  verifyPassword,
} from '@abaya/crypto';
import { ServiceError } from './errors.js';

/** Política de sesión y bloqueo del panel (sección 8). */
export const SESSION_MAX_MS = 8 * 3_600_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60_000;
/** No se escribe `lastSeenAt` en cada petición (el panel refresca cada 10 s). */
const TOUCH_EVERY_MS = 60_000;

export const ROLES = ['ADMIN', 'OPERADOR'] as const satisfies readonly AdminRole[];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

export interface PublicUser {
  id: string;
  username: string;
  role: AdminRole;
  active: boolean;
  mustChangePassword: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

const PUBLIC_FIELDS = {
  id: true,
  username: true,
  role: true,
  active: true,
  mustChangePassword: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdBy: true,
  createdAt: true,
} as const;

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: AdminRole;
  mustChangePassword: boolean;
  sessionId: string;
}

/** Error de negocio de usuarios (el controlador lo traduce a HTTP). */
export class UsersError extends ServiceError {}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function normalizeUsername(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Usuarios del panel: contraseñas, sesiones en el servidor y gestión por el ADMIN.
 * Nunca guarda ni registra contraseñas ni tokens: solo sus hashes.
 */
export class UsersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Devuelve el token de sesión (solo para la cookie) o null con un motivo genérico. */
  async login(
    rawUsername: unknown,
    password: unknown,
  ): Promise<{ token: string; user: AuthenticatedUser } | null> {
    const username = normalizeUsername(rawUsername);
    const pw = typeof password === 'string' ? password : '';
    const now = this.now();
    const user = username ? await this.prisma.adminUser.findUnique({ where: { username } }) : null;

    if (!user || !user.active) {
      // Mismo costo que una verificación real: no revela si el usuario existe.
      await verifyPassword(pw, DUMMY_PASSWORD_HASH);
      await this.audit(username || '—', 'LOGIN_FAILED');
      return null;
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      await verifyPassword(pw, DUMMY_PASSWORD_HASH);
      await this.audit(username, 'LOGIN_BLOCKED');
      return null;
    }
    if (!(await verifyPassword(pw, user.passwordHash))) {
      const fails = user.failedAttempts + 1;
      const lock = fails >= MAX_FAILED_LOGINS;
      await this.prisma.adminUser.update({
        where: { id: user.id },
        data: lock
          ? { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) }
          : { failedAttempts: fails },
      });
      await this.audit(username, lock ? 'USER_LOCKED' : 'LOGIN_FAILED');
      return null;
    }

    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.adminSession.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: now } },
            { lastSeenAt: { lt: new Date(now.getTime() - SESSION_IDLE_MS) } },
          ],
        },
      }),
      this.prisma.adminUser.update({
        where: { id: user.id },
        data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: now },
      }),
    ]);
    const session = await this.prisma.adminSession.create({
      data: {
        tokenHash: tokenHash(token),
        userId: user.id,
        expiresAt: new Date(now.getTime() + SESSION_MAX_MS),
        lastSeenAt: now,
      },
    });
    await this.audit(username, 'LOGIN');
    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        sessionId: session.id,
      },
    };
  }

  /** Usuario de una sesión válida, o null (vencida, inactiva o usuario desactivado). */
  async authenticate(token: string | undefined): Promise<AuthenticatedUser | null> {
    if (!token) return null;
    const now = this.now();
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: { user: true },
    });
    if (!session) return null;
    const idle = now.getTime() - session.lastSeenAt.getTime();
    if (session.expiresAt <= now || idle > SESSION_IDLE_MS || !session.user.active) {
      await this.prisma.adminSession.deleteMany({ where: { id: session.id } });
      return null;
    }
    if (idle > TOUCH_EVERY_MS) {
      await this.prisma.adminSession.update({
        where: { id: session.id },
        data: { lastSeenAt: now },
      });
    }
    const { user } = session;
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      sessionId: session.id,
    };
  }

  async logout(token: string | undefined, actor?: string): Promise<void> {
    if (!token) return;
    const r = await this.prisma.adminSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
    if (r.count && actor) await this.audit(actor, 'LOGOUT');
  }

  /** Cambio de la propia contraseña; cierra las demás sesiones del usuario. */
  async changePassword(me: AuthenticatedUser, current: unknown, next: unknown): Promise<void> {
    const cur = typeof current === 'string' ? current : '';
    const nxt = typeof next === 'string' ? next : '';
    const user = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: me.id } });
    if (!(await verifyPassword(cur, user.passwordHash))) {
      await this.audit(me.username, 'PASSWORD_CHANGE_FAILED');
      throw new UsersError(400, 'La contraseña actual no es correcta');
    }
    const issues = passwordIssues(nxt, user.username);
    if (cur === nxt) issues.push('Debe ser distinta de la actual');
    if (issues.length) throw new UsersError(400, issues.join('. '));
    const passwordHash = await hashPassword(nxt);
    await this.prisma.$transaction([
      this.prisma.adminUser.update({
        where: { id: me.id },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.adminSession.deleteMany({
        where: { userId: me.id, id: { not: me.sessionId } },
      }),
    ]);
    await this.audit(me.username, 'PASSWORD_CHANGED');
  }

  async list(): Promise<PublicUser[]> {
    return this.prisma.adminUser.findMany({ orderBy: { username: 'asc' }, select: PUBLIC_FIELDS });
  }

  /** Crea un usuario con contraseña temporal (se muestra una sola vez). */
  async create(
    actor: string,
    input: { username?: unknown; role?: unknown },
  ): Promise<{ user: PublicUser; temporaryPassword: string }> {
    const username = normalizeUsername(input.username);
    if (!USERNAME_RE.test(username)) {
      throw new UsersError(
        400,
        'Usuario inválido: 3 a 40 caracteres, minúsculas, números, punto, guion o guion bajo',
      );
    }
    const role = this.parseRole(input.role);
    if (await this.prisma.adminUser.findUnique({ where: { username } })) {
      throw new UsersError(409, 'Ese usuario ya existe');
    }
    const temporaryPassword = generateTemporaryPassword();
    const user = await this.prisma.adminUser.create({
      data: {
        username,
        role,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        createdBy: actor,
      },
      select: PUBLIC_FIELDS,
    });
    await this.audit(actor, 'USER_CREATED', `${username}:${role}`);
    return { user, temporaryPassword };
  }

  /** Cambia rol o estado. Nadie se modifica a sí mismo y siempre queda un ADMIN activo. */
  async update(
    me: AuthenticatedUser,
    id: string,
    input: { role?: unknown; active?: unknown },
  ): Promise<PublicUser> {
    const role = input.role === undefined ? undefined : this.parseRole(input.role);
    if (input.active !== undefined && typeof input.active !== 'boolean') {
      throw new UsersError(400, 'active debe ser booleano');
    }
    const active = input.active as boolean | undefined;
    if (role === undefined && active === undefined) throw new UsersError(400, 'Nada que cambiar');
    if (id === me.id) {
      throw new UsersError(403, 'No puede cambiar su propio rol ni desactivarse');
    }

    const updated = await withSerializableRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const target = await tx.adminUser.findUnique({ where: { id } });
          if (!target) throw new UsersError(404, 'Usuario no encontrado');
          const losesAdmin =
            target.role === 'ADMIN' &&
            target.active &&
            ((role !== undefined && role !== 'ADMIN') || active === false);
          if (losesAdmin) {
            const admins = await tx.adminUser.count({ where: { role: 'ADMIN', active: true } });
            if (admins <= 1) throw new UsersError(409, 'Debe quedar al menos un ADMIN activo');
          }
          const u = await tx.adminUser.update({
            where: { id },
            data: {
              ...(role !== undefined ? { role } : {}),
              ...(active !== undefined ? { active } : {}),
            },
            select: PUBLIC_FIELDS,
          });
          if (active === false) await tx.adminSession.deleteMany({ where: { userId: id } });
          return { before: target, after: u };
        },
        { isolationLevel: 'Serializable' },
      ),
    );

    const { before, after } = updated;
    if (role !== undefined && role !== before.role) {
      await this.audit(me.username, 'USER_ROLE_CHANGED', `${after.username}:${role}`);
    }
    if (active !== undefined && active !== before.active) {
      await this.audit(me.username, active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', after.username);
    }
    return after;
  }

  /** Nueva contraseña temporal para otro usuario; desbloquea y cierra sus sesiones. */
  async resetPassword(
    me: AuthenticatedUser,
    id: string,
  ): Promise<{ user: PublicUser; temporaryPassword: string }> {
    if (id === me.id) {
      throw new UsersError(403, 'Use "Cambiar contraseña" para su propia cuenta');
    }
    const exists = await this.prisma.adminUser.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new UsersError(404, 'Usuario no encontrado');
    const r = await this.setTemporaryPassword(id);
    await this.audit(me.username, 'PASSWORD_RESET', r.user.username);
    return r;
  }

  /**
   * Alta o recuperación de un ADMIN desde la consola del servidor (primer administrador o
   * cuando nadie puede entrar). No pasa por la API.
   */
  async bootstrapAdmin(
    rawUsername: string,
    opts: { reset: boolean },
  ): Promise<{ user: PublicUser; temporaryPassword: string; created: boolean }> {
    const username = normalizeUsername(rawUsername);
    const existing = await this.prisma.adminUser.findUnique({ where: { username } });
    if (!existing) {
      const r = await this.create('consola', { username, role: 'ADMIN' });
      return { ...r, created: true };
    }
    if (!opts.reset) {
      throw new UsersError(409, 'Ese usuario ya existe (use --reset para restablecerlo)');
    }
    await this.prisma.adminUser.update({
      where: { id: existing.id },
      data: { role: 'ADMIN', active: true },
    });
    const r = await this.setTemporaryPassword(existing.id);
    await this.audit('consola', 'PASSWORD_RESET', username);
    return { ...r, created: false };
  }

  private async setTemporaryPassword(id: string) {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const [user] = await this.prisma.$transaction([
      this.prisma.adminUser.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, failedAttempts: 0, lockedUntil: null },
        select: PUBLIC_FIELDS,
      }),
      this.prisma.adminSession.deleteMany({ where: { userId: id } }),
    ]);
    return { user, temporaryPassword };
  }

  private parseRole(raw: unknown): AdminRole {
    if (!ROLES.includes(raw as AdminRole)) {
      throw new UsersError(400, `Rol inválido: use ${ROLES.join(' o ')}`);
    }
    return raw as AdminRole;
  }

  private async audit(actor: string, action: string, target?: string) {
    await this.prisma.adminAuditLog.create({
      data: { actor: actor.slice(0, 60), action, target: target ?? null },
    });
  }
}
