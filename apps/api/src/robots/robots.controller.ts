import { createReadStream, existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard, Roles, type AdminRequest } from '../admin/admin-auth.guard.js';
import { toHttp } from '../admin/http-errors.js';
import { RobotGateway } from './gateway/robot-gateway.service.js';
import { RobotsService, parseRange } from './robots.service.js';

/** Token de inyección: ruta del paquete instalador de los robots hijos (o null). */
export const ROBOT_PACKAGE_FILE = Symbol('ROBOT_PACKAGE_FILE');

/** Panel → robots (v1.4): consulta para ambos roles; gestión solo ADMIN. */
@Controller('admin/robots')
@UseGuards(AdminAuthGuard)
export class RobotsController {
  constructor(
    @Inject(RobotsService) private readonly robots: RobotsService,
    @Inject(ROBOT_PACKAGE_FILE) private readonly packageFile: string | null,
    @Inject(RobotGateway) private readonly gateway: RobotGateway,
  ) {}

  @Get()
  list(@Query('rango') rango?: string) {
    return this.robots.list(parseRange(rango));
  }

  /** Paquete instalador para los equipos (sin secretos: solo código). */
  @Get('package')
  download(@Res({ passthrough: true }) res: { setHeader(n: string, v: string): void }) {
    if (!this.packageFile || !existsSync(this.packageFile)) {
      throw new NotFoundException('El paquete del robot no está disponible en el servidor');
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${basename(this.packageFile).replace(/"/g, '')}"`,
    );
    return new StreamableFile(createReadStream(this.packageFile));
  }

  @Get(':robotUser')
  detail(@Param('robotUser') robotUser: string, @Query('rango') rango?: string) {
    return toHttp(this.robots.detail(robotUser, parseRange(rango)));
  }

  /** Trazas de error subidas por el robot (v1.6): solo ADMIN (contienen pantallas). */
  @Get(':robotUser/traces')
  @Roles(['ADMIN'])
  traces(@Param('robotUser') robotUser: string) {
    return this.gateway.listTraces(robotUser);
  }

  @Get(':robotUser/traces/:ref')
  @Roles(['ADMIN'])
  async trace(
    @Param('robotUser') robotUser: string,
    @Param('ref') ref: string,
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: { setHeader(n: string, v: string): void },
  ) {
    const zip = await toHttp(this.gateway.readTrace(robotUser, ref));
    await this.robots.recordAudit(req.adminUser, 'TRACE_DOWNLOADED', `${robotUser}:${ref}`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${ref}.zip"`);
    return new StreamableFile(zip);
  }

  @Post()
  @Roles(['ADMIN'])
  create(
    @Body()
    body: { robotUser?: unknown; abayaPassword?: unknown; mfaMode?: unknown; totpSecret?: unknown },
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.robots.create(req.adminUser, body ?? {}));
  }

  @Patch(':robotUser/credentials')
  @Roles(['ADMIN'])
  credentials(
    @Param('robotUser') robotUser: string,
    @Body() body: { abayaPassword?: unknown; mfaMode?: unknown; totpSecret?: unknown },
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.robots.updateCredentials(req.adminUser, robotUser, body ?? {}));
  }

  @Post(':robotUser/enrollment-code')
  @Roles(['ADMIN'])
  enrollmentCode(@Param('robotUser') robotUser: string, @Req() req: AdminRequest) {
    return toHttp(this.robots.newEnrollmentCode(req.adminUser, robotUser));
  }

  /** v1.7: actualizar a la versión publicada (cuando el robot quede libre). */
  @Post('update-all')
  @HttpCode(200)
  @Roles(['ADMIN'])
  updateAll(@Req() req: AdminRequest) {
    return toHttp(this.robots.requestUpdateAll(req.adminUser));
  }

  @Post(':robotUser/update')
  @HttpCode(200)
  @Roles(['ADMIN'])
  update(@Param('robotUser') robotUser: string, @Req() req: AdminRequest) {
    return toHttp(this.robots.requestUpdate(req.adminUser, robotUser));
  }

  @Post(':robotUser/update/cancel')
  @HttpCode(200)
  @Roles(['ADMIN'])
  cancelUpdate(@Param('robotUser') robotUser: string, @Req() req: AdminRequest) {
    return toHttp(this.robots.cancelUpdate(req.adminUser, robotUser));
  }

  @Post(':robotUser/pause')
  @HttpCode(200)
  @Roles(['ADMIN'])
  pause(
    @Param('robotUser') robotUser: string,
    @Body() body: { paused?: unknown },
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.robots.setPaused(req.adminUser, robotUser, body?.paused));
  }

  @Post(':robotUser/enabled')
  @HttpCode(200)
  @Roles(['ADMIN'])
  enabled(
    @Param('robotUser') robotUser: string,
    @Body() body: { enabled?: unknown },
    @Req() req: AdminRequest,
  ) {
    return toHttp(this.robots.setEnabled(req.adminUser, robotUser, body?.enabled));
  }
}
