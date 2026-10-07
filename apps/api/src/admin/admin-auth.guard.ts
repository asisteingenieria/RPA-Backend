import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminRole } from '@abaya/db';
import { UsersService, type AuthenticatedUser } from './users.service.js';

export const SESSION_COOKIE = 'abaya_admin';
/** Cabecera obligatoria en peticiones que cambian algo: un formulario de otro sitio no la puede poner. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'abaya-panel';

const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60_000;

/** Bloqueo por IP tras intentos fallidos (frena la fuerza bruta contra el login). */
export class FailedAuthLimiter {
  private readonly fails = new Map<
    string,
    { count: number; since: number; blockedUntil?: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  isBlocked(ip: string): boolean {
    const f = this.fails.get(ip);
    return !!f?.blockedUntil && f.blockedUntil > this.now();
  }

  fail(ip: string): void {
    const t = this.now();
    const f = this.fails.get(ip);
    if (!f || t - f.since > WINDOW_MS) {
      this.fails.set(ip, { count: 1, since: t });
      return;
    }
    f.count++;
    if (f.count >= MAX_FAILS) f.blockedUntil = t + WINDOW_MS;
  }

  success(ip: string): void {
    this.fails.delete(ip);
  }
}

/** Roles que pueden usar una ruta (sin decorador: cualquier usuario autenticado). */
export const Roles = Reflector.createDecorator<AdminRole[]>();
/** Ruta permitida aunque el usuario tenga pendiente cambiar su contraseña temporal. */
export const AllowPendingPassword = Reflector.createDecorator<true>();

export interface AdminRequest {
  method: string;
  headers: Record<string, string | undefined>;
  ip?: string;
  adminUser: string;
  me: AuthenticatedUser;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || undefined;
  }
  return undefined;
}

export function requireCsrfHeader(req: Pick<AdminRequest, 'method' | 'headers'>): void {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
    throw new ForbiddenException('Petición sin la cabecera del panel');
  }
}

/**
 * Autenticación del panel/API de administración (sección 8): sesión en el servidor con
 * cookie httpOnly, roles por ruta y cambio obligatorio de la contraseña temporal.
 * Sin sesión válida responde 401; nunca hay acceso anónimo.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    requireCsrfHeader(req);
    const me = await this.users.authenticate(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!me) throw new UnauthorizedException('Sesión no válida o vencida');

    const targets = [ctx.getHandler(), ctx.getClass()];
    if (me.mustChangePassword && !this.reflector.getAllAndOverride(AllowPendingPassword, targets)) {
      throw new HttpException(
        {
          statusCode: 403,
          message: 'Debe cambiar su contraseña temporal',
          code: 'PASSWORD_CHANGE_REQUIRED',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    const roles = this.reflector.getAllAndOverride(Roles, targets);
    if (roles?.length && !roles.includes(me.role)) {
      throw new ForbiddenException('Su rol no permite esta acción');
    }
    req.me = me;
    req.adminUser = me.username;
    return true;
  }
}
