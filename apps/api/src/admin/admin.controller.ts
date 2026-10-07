import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard, Roles, type AdminRequest } from './admin-auth.guard.js';
import { AdminService } from './admin.service.js';

@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('review')
  review() {
    return this.admin.reviewQueue();
  }

  @Get('audit')
  @Roles(['ADMIN'])
  audit() {
    return this.admin.auditLog();
  }

  @Get('kill-switch')
  async killSwitch() {
    return { killSwitch: await this.admin.killSwitchActive() };
  }

  @Post('kill-switch')
  setKillSwitch(@Body() body: { active?: unknown }, @Req() req: AdminRequest) {
    if (typeof body?.active !== 'boolean')
      throw new BadRequestException('active debe ser booleano');
    // Cualquiera puede detener el robot; reanudarlo es decisión de un ADMIN.
    if (!body.active && req.me.role !== 'ADMIN')
      throw new ForbiddenException('Solo un ADMIN puede reanudar el robot');
    return this.admin.setKillSwitch(body.active, req.adminUser);
  }

  @Post('sessions/:robotUser/reset')
  @Roles(['ADMIN'])
  resetSession(@Param('robotUser') robotUser: string, @Req() req: AdminRequest) {
    return this.admin.resetSession(robotUser, req.adminUser);
  }
}
