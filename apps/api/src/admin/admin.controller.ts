import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminService } from './admin.service.js';

interface AdminRequest {
  adminUser: string;
}

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
    return this.admin.setKillSwitch(body.active, req.adminUser);
  }

  @Post('sessions/:robotUser/reset')
  resetSession(@Param('robotUser') robotUser: string, @Req() req: AdminRequest) {
    return this.admin.resetSession(robotUser, req.adminUser);
  }
}
