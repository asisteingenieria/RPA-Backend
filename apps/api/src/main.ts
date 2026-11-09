import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@abaya/config';
import { createLogger } from '@abaya/logger';
import { AppModule, hubDeps } from './app.module.js';
import { RobotWsHub } from './robots/gateway/ws-hub.js';
import { parseTrustProxy, securityHeaders } from './security-headers.js';

const config = loadConfig();
const logger = createLogger('api');

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
app.enableShutdownHooks();
app.disable('x-powered-by');
// Detrás de nginx, sin esto todas las peticiones llegan como 127.0.0.1 y el bloqueo por intentos
// fallidos (login del panel y tokens de los robots) bloquearía a TODOS a la vez.
app.set('trust proxy', parseTrustProxy(config.TRUST_PROXY));
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
