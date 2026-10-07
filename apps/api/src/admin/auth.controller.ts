import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthGuard,
  AllowPendingPassword,
  FailedAuthLimiter,
  SESSION_COOKIE,
  readCookie,
  requireCsrfHeader,
  type AdminRequest,
} from './admin-auth.guard.js';
import { toHttp } from './http-errors.js';
import { SESSION_MAX_MS, UsersService } from './users.service.js';

/** Token de inyección: si la cookie de sesión lleva `Secure` (false solo en desarrollo por HTTP). */
export const COOKIE_SECURE = Symbol('COOKIE_SECURE');

interface CookieResponse {
  setHeader(name: string, value: string): void;
}

@Controller('admin/auth')
export class AuthController {
  private readonly limiter = new FailedAuthLimiter();

  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(COOKIE_SECURE) private readonly secure: boolean,
  ) {}

  private cookie(value: string, maxAgeSec: number): string {
    return [
      `${SESSION_COOKIE}=${value}`,
      'Path=/admin',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSec}`,
      ...(this.secure ? ['Secure'] : []),
    ].join('; ');
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { username?: unknown; password?: unknown },
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    requireCsrfHeader(req);
    const ip = req.ip ?? 'desconocida';
    if (this.limiter.isBlocked(ip)) {
      throw new HttpException('Demasiados intentos fallidos', HttpStatus.TOO_MANY_REQUESTS);
    }
    const r = await this.users.login(body?.username, body?.password);
    if (!r) {
      this.limiter.fail(ip);
      // Mensaje único: no revela si el usuario existe, está bloqueado o desactivado.
      throw new UnauthorizedException(
        'Usuario o contraseña incorrectos, o cuenta bloqueada temporalmente',
      );
    }
    this.limiter.success(ip);
    res.setHeader('Set-Cookie', this.cookie(r.token, SESSION_MAX_MS / 1000));
    const { username, role, mustChangePassword } = r.user;
    return { username, role, mustChangePassword };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AdminRequest, @Res({ passthrough: true }) res: CookieResponse) {
    requireCsrfHeader(req);
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const me = await this.users.authenticate(token);
    await this.users.logout(token, me?.username);
    res.setHeader('Set-Cookie', this.cookie('', 0));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  @AllowPendingPassword()
  me(@Req() req: AdminRequest) {
    const { username, role, mustChangePassword } = req.me;
    return { username, role, mustChangePassword };
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  @AllowPendingPassword()
  async changePassword(
    @Body() body: { currentPassword?: unknown; newPassword?: unknown },
    @Req() req: AdminRequest,
  ) {
    await toHttp(this.users.changePassword(req.me, body?.currentPassword, body?.newPassword));
    return { ok: true };
  }
}
