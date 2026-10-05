import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@abaya/config';
import { createLogger } from '@abaya/logger';
import { AppModule } from './app.module.js';

const config = loadConfig();
const logger = createLogger('rpa');

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
app.enableShutdownHooks();
await app.listen(config.RPA_PORT);
logger.info({ port: config.RPA_PORT }, 'rpa escuchando');
