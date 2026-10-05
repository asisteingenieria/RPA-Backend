import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@abaya/config';
import { createLogger } from '@abaya/logger';
import { AppModule } from './app.module.js';

const config = loadConfig();
const logger = createLogger('api');

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
app.enableShutdownHooks();
await app.listen(config.API_PORT);
logger.info({ port: config.API_PORT }, 'api escuchando');
