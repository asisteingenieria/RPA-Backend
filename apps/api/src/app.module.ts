import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadConfig } from '@abaya/config';
import { createPrismaClient } from '@abaya/db';
import { ADMIN_TOKEN, AdminAuthGuard } from './admin/admin-auth.guard.js';
import { AdminController } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { RedisFlagStore } from './admin/flags.js';
import { HealthController } from './health/health.controller.js';

const cfg = loadConfig();
const prisma = createPrismaClient(cfg.DATABASE_URL);
const flags = new RedisFlagStore(cfg.REDIS_URL);

@Module({
  controllers: [HealthController, AdminController],
  providers: [
    { provide: AdminService, useValue: new AdminService(prisma, flags) },
    { provide: ADMIN_TOKEN, useValue: cfg.ADMIN_TOKEN ?? null },
    AdminAuthGuard,
  ],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await flags.close();
    await prisma.$disconnect();
  }
}
