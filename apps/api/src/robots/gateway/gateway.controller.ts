import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { MAX_AUDIO_BYTES } from '@abaya/domain';
import {
  GATEWAY_PATH,
  INBOUND_AUDIO_PATH,
  OUTBOUND_IMAGE_PATH,
  rpcRequestSchema,
} from '@abaya/robot-store';
import { FailedAuthLimiter, type AdminRequest } from '../../admin/admin-auth.guard.js';
import { toHttp } from '../../admin/http-errors.js';
import { readBody, type RawRequest as BodyStream } from '../../raw-body.js';
import { ReleaseService } from '../release.service.js';
import { RobotsService } from '../robots.service.js';
import { MAX_TRACE_BYTES, RobotGateway } from './robot-gateway.service.js';

/** Límite por robot: sobra para 3 chats y frena un equipo comprometido que inunde la pasarela. */
const RATE_PER_SEC = 50;
const BURST = 200;

class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  take(key: string): boolean {
    const t = Date.now();
    const b = this.buckets.get(key) ?? { tokens: BURST, at: t };
    b.tokens = Math.min(BURST, b.tokens + ((t - b.at) / 1000) * RATE_PER_SEC);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

type RawRequest = AdminRequest & BodyStream;

/** Mapea errores de la persistencia que no son de servicio (p. ej. chat de otro robot). */
async function gatewayHttp<T>(p: Promise<T>): Promise<T> {
  try {
    return await toHttp(p);
  } catch (err) {
    if (err instanceof Error && err.name === 'ChatOwnedByOtherRobotError') {
      throw new HttpException('Chat ajeno', HttpStatus.FORBIDDEN);
    }
    throw err;
  }
}

/**
 * Pasarela de robots hijos (v1.6, sección 2.8). Lo único que un equipo robot puede hacer
 * contra el servidor; todo por HTTPS y con el robot deducido del token.
 */
@Controller(GATEWAY_PATH)
export class RobotGatewayController {
  private readonly failedAuth = new FailedAuthLimiter();
  private readonly rate = new RateLimiter();

  constructor(
    @Inject(RobotsService) private readonly robots: RobotsService,
    @Inject(RobotGateway) private readonly gateway: RobotGateway,
    @Inject(ReleaseService) private readonly release: ReleaseService,
  ) {}

  /** Instalación: código de un solo uso → token de renovación del equipo. */
  @Post('enroll')
  enroll(@Body() body: { code?: unknown; host?: unknown }, @Req() req: AdminRequest) {
    return this.unauthenticated(req, () => this.robots.enroll(body?.code, body?.host));
  }

  /** Token de renovación → token de acceso (1 h) + token de renovación nuevo. */
  @Post('token')
  @HttpCode(200)
  token(@Body() body: { refreshToken?: unknown }, @Req() req: AdminRequest) {
    return this.unauthenticated(req, () => this.robots.refresh(body?.refreshToken));
  }

  /** Lo que el robot necesita para Abaya (sin base de datos, Redis ni claves). */
  @Get('config')
  async config(@Req() req: AdminRequest) {
    const robotUser = await this.auth(req);
    return gatewayHttp(this.robots.robotConfig(robotUser));
  }

  @Post('rpc')
  @HttpCode(200)
  async rpc(@Body() body: unknown, @Req() req: AdminRequest) {
    const robotUser = await this.auth(req);
    const parsed = rpcRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('Operación desconocida', HttpStatus.BAD_REQUEST);
    const result = await gatewayHttp(
      this.gateway.call(robotUser, parsed.data.method, parsed.data.params),
    );
    return { result };
  }

  /** Manifiesto firmado de la versión publicada (el robot verifica la firma). */
  @Get('release')
  async releaseManifest(@Req() req: AdminRequest) {
    await this.auth(req);
    const p = this.release.published();
    if (!p?.signatureValid) {
      throw new HttpException('No hay versión publicada', HttpStatus.NOT_FOUND);
    }
    return p.signed;
  }

  @Get('release/package')
  async releasePackage(
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: { setHeader(n: string, v: string): void },
  ) {
    await this.auth(req);
    const p = this.release.published();
    if (!p?.signatureValid || !this.release.file) {
      throw new HttpException('No hay versión publicada', HttpStatus.NOT_FOUND);
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(p.size));
    return new StreamableFile(createReadStream(this.release.file));
  }

  /** Traza de error (zip) subida por el robot; el servidor la guarda cifrada. */
  @Post('traces/:ref')
  @HttpCode(204)
  async trace(@Param('ref') ref: string, @Req() req: RawRequest) {
    const robotUser = await this.auth(req);
    const zip = await readBody(req, MAX_TRACE_BYTES, 'Traza demasiado grande');
    await gatewayHttp(this.gateway.saveTrace(robotUser, ref, zip));
  }

  /** D-010: nota de voz del cliente (audio en el cuerpo, datos del mensaje en la query). */
  @Post(INBOUND_AUDIO_PATH)
  @HttpCode(200)
  async inboundAudio(@Query() query: unknown, @Req() req: RawRequest) {
    const robotUser = await this.auth(req);
    const audio = await readBody(req, MAX_AUDIO_BYTES, 'Audio demasiado grande');
    return { result: await gatewayHttp(this.gateway.storeInboundAudio(robotUser, query, audio)) };
  }

  /** D-014 fase 2: imagen de planes de un mensaje saliente del robot (solo de los suyos). */
  @Get(OUTBOUND_IMAGE_PATH)
  async outboundImage(
    @Query('messageId') messageId: unknown,
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: { setHeader(n: string, v: string): void },
  ) {
    const robotUser = await this.auth(req);
    const img = await gatewayHttp(this.gateway.outboundImage(robotUser, messageId));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(Buffer.from(img));
  }

  private async auth(req: AdminRequest): Promise<string> {
    const robotUser = await gatewayHttp(this.robots.authenticate(req.headers.authorization));
    if (!this.rate.take(robotUser)) {
      throw new HttpException('Demasiadas peticiones', HttpStatus.TOO_MANY_REQUESTS);
    }
    return robotUser;
  }

  /** Códigos y tokens de renovación: fuerza bruta frenada por IP. */
  private async unauthenticated<T>(req: AdminRequest, fn: () => Promise<T>): Promise<T> {
    const ip = req.ip ?? 'desconocida';
    if (this.failedAuth.isBlocked(ip)) {
      throw new HttpException('Demasiados intentos fallidos', HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      const r = await gatewayHttp(fn());
      this.failedAuth.success(ip);
      return r;
    } catch (err) {
      if (err instanceof HttpException && [400, 401, 403].includes(err.getStatus())) {
        this.failedAuth.fail(ip);
      }
      throw err;
    }
  }
}
