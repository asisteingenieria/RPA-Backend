import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

/** Token de inyección del ADMIN_TOKEN (null si no está configurado). */
export const ADMIN_TOKEN = Symbol('ADMIN_TOKEN');

const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60_000;

/** Bloqueo por IP tras intentos fallidos (frena la fuerza bruta del token). */
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

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Autenticación del panel/API de administración: `Authorization: Bearer <ADMIN_TOKEN>`.
 * Sin ADMIN_TOKEN configurado, /admin queda deshabilitado (503), nunca abierto.
 * El operador se identifica con `X-Admin-User` para la auditoría.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  private readonly limiter = new FailedAuthLimiter();

  constructor(@Inject(ADMIN_TOKEN) private readonly token: string | null | undefined) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.token || this.token.length < 24) {
      throw new ServiceUnavailableException(
        'Administración deshabilitada: ADMIN_TOKEN no configurado',
      );
    }
    const req = ctx
      .switchToHttp()
      .getRequest<{
        headers: Record<string, string | undefined>;
        adminUser?: string;
        ip?: string;
      }>();
    const ip = req.ip ?? 'desconocida';
    if (this.limiter.isBlocked(ip)) {
      throw new HttpException('Demasiados intentos fallidos', HttpStatus.TOO_MANY_REQUESTS);
    }
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given) {
      this.limiter.fail(ip);
      throw new UnauthorizedException();
    }
    // Comparación en tiempo constante sobre digests de igual longitud.
    if (!timingSafeEqual(digest(given), digest(this.token))) {
      this.limiter.fail(ip);
      throw new ForbiddenException();
    }
    this.limiter.success(ip);
    const user = (req.headers['x-admin-user'] ?? 'admin').replace(/[^\w.@-]/g, '').slice(0, 60);
    req.adminUser = user || 'admin';
    return true;
  }
}
