import { fileURLToPath } from 'node:url';
import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadConfig } from '@abaya/config';
import { cipherFromConfig } from '@abaya/crypto';
import { createPrismaClient } from '@abaya/db';
import { AdminAuthGuard } from './admin/admin-auth.guard.js';
import { AdminController } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { AuthController, COOKIE_SECURE } from './admin/auth.controller.js';
import { RedisFlagStore } from './admin/flags.js';
import { UsersController } from './admin/users.controller.js';
import { UsersService } from './admin/users.service.js';
import { HealthController } from './health/health.controller.js';
import { alertsFromConfig } from '@abaya/alerts';
import { createLogger } from '@abaya/logger';
import { RobotGatewayController } from './robots/gateway/gateway.controller.js';
import { RobotGateway } from './robots/gateway/robot-gateway.service.js';
import type { HubDeps } from './robots/gateway/ws-hub.js';
import { ROBOT_PACKAGE_FILE, RobotsController } from './robots/robots.controller.js';
import { ReleaseService } from './robots/release.service.js';
import { RobotAccessTokens } from './robots/robot-tokens.js';
import { RobotsService } from './robots/robots.service.js';

const cfg = loadConfig();
const prisma = createPrismaClient(cfg.DATABASE_URL);
const flags = new RedisFlagStore(cfg.REDIS_URL);

// Servidor padre (v1.4) y pasarela de robots hijos (v1.6, sección 2.8).
const cipher = cipherFromConfig(cfg);
const alerts = alertsFromConfig(cfg, createLogger('api.alerts'));
const packageFile =
  cfg.ROBOT_PACKAGE_FILE ??
  fileURLToPath(new URL('../../../dist/robot-package/abaya-robot-windows.zip', import.meta.url));
const release = new ReleaseService(
  packageFile,
  cfg.ROBOT_RELEASE_PUBLIC_KEY ??
    fileURLToPath(new URL('../../rpa/release-key.pub', import.meta.url)),
);
const robots = new RobotsService(
  prisma,
  flags,
  cipher,
  {
    nodeEnv: cfg.NODE_ENV,
    abayaBaseUrl: cfg.ABAYA_BASE_URL,
    heartbeatMs: cfg.HEARTBEAT_INTERVAL_MS,
  },
  {
    maxChatsPerRobot: cfg.MAX_CHATS_PER_ROBOT,
    tokens: new RobotAccessTokens(cfg.FIELD_ENCRYPTION_KEY, Date.now, cfg.ROBOT_ACCESS_TTL_MS),
    alerts,
    release,
  },
);
const gateway = new RobotGateway({
  prisma,
  cipher,
  redisUrl: cfg.REDIS_URL,
  alerts,
  traceDir: cfg.TRACE_DIR,
});
/** Lo que necesita el WebSocket de la pasarela (lo monta main.ts sobre el servidor HTTP). */
export const hubDeps: HubDeps = {
  robots,
  prisma,
  flags,
  redisUrl: cfg.REDIS_URL,
  logger: createLogger('api.gateway'),
  release,
};
const traceCleanup = setInterval(() => void gateway.cleanupTraces(), 6 * 3_600_000);
traceCleanup.unref();

@Module({
  controllers: [
    HealthController,
    AuthController,
    AdminController,
    UsersController,
    RobotsController,
    RobotGatewayController,
  ],
  providers: [
    { provide: AdminService, useValue: new AdminService(prisma, flags) },
    { provide: UsersService, useValue: new UsersService(prisma) },
    { provide: RobotsService, useValue: robots },
    { provide: RobotGateway, useValue: gateway },
    { provide: ReleaseService, useValue: release },
    { provide: COOKIE_SECURE, useValue: cfg.ADMIN_COOKIE_SECURE },
    { provide: ROBOT_PACKAGE_FILE, useValue: packageFile },
    AdminAuthGuard,
  ],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    clearInterval(traceCleanup);
    await gateway.close();
    await flags.close();
    await prisma.$disconnect();
  }
}
