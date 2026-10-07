import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, Roles, type AdminRequest } from './admin-auth.guard.js';
import { toHttp } from './http-errors.js';
import { UsersService } from './users.service.js';

/** Gestión de usuarios del panel: solo ADMIN (sección 9, F7). */
@Controller('admin/users')
@UseGuards(AdminAuthGuard)
@Roles(['ADMIN'])
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  /** Devuelve la contraseña temporal una sola vez; no se guarda en ningún lado en claro. */
  @Post()
  create(@Body() body: { username?: unknown; role?: unknown }, @Req() req: AdminRequest) {
    return toHttp(this.users.create(req.adminUser, body ?? {}));
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { role?: unknown; active?: unknown; knowledgePublisher?: unknown },
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.users.update(req.me, id, body ?? {}));
  }

  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Req() req: AdminRequest) {
    return toHttp(this.users.resetPassword(req.me, id));
  }
}
