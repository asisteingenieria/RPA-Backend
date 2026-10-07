import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@abaya/config';
import { createLogger } from '@abaya/logger';
import { AppModule, hubDeps } from './app.module.js';
import { RobotWsHub } from './robots/gateway/ws-hub.js';
import { securityHeaders } from './security-headers.js';

const config = loadConfig();
const logger = createLogger('api');

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
app.enableShutdownHooks();
app.disable('x-powered-by');
app.use(securityHeaders);

// Panel de operación (F7): build estático de apps/panel servido en /panel.
const panelDir =
  process.env.PANEL_DIR ?? fileURLToPath(new URL('../../panel/dist', import.meta.url));
if (existsSync(panelDir)) {
  app.useStaticAssets(panelDir, { prefix: '/panel', index: 'index.html' });
  logger.info({ panelDir }, 'panel disponible en /panel');
}

// Pasarela de robots hijos (v1.6): WebSocket en /robot-api/v1/ws sobre el mismo servidor.
const hub = new RobotWsHub(app.getHttpServer(), hubDeps);
process.once('SIGTERM', () => void hub.close());
process.once('SIGINT', () => void hub.close());

await app.listen(config.API_PORT);
logger.info({ port: config.API_PORT }, 'api escuchando');
