import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

/** Token de inyección del ADMIN_TOKEN (null si no está configurado). */
export const ADMIN_TOKEN = Symbol('ADMIN_TOKEN');

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Autenticación del panel/API de administración: `Authorization: Bearer <ADMIN_TOKEN>`.
 * Sin ADMIN_TOKEN configurado, /admin queda deshabilitado (503), nunca abierto.
 * El operador se identifica con `X-Admin-User` para la auditoría.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(@Inject(ADMIN_TOKEN) private readonly token: string | null | undefined) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.token || this.token.length < 24) {
      throw new ServiceUnavailableException(
        'Administración deshabilitada: ADMIN_TOKEN no configurado',
      );
    }
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; adminUser?: string }>();
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given) throw new UnauthorizedException();
    // Comparación en tiempo constante sobre digests de igual longitud.
    if (!timingSafeEqual(digest(given), digest(this.token))) throw new ForbiddenException();
    const user = (req.headers['x-admin-user'] ?? 'admin').replace(/[^\w.@-]/g, '').slice(0, 60);
    req.adminUser = user || 'admin';
    return true;
  }
}
