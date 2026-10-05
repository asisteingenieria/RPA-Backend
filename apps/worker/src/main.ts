import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger } from '@abaya/logger';
import { WorkerModule } from './worker.module.js';

const logger = createLogger('worker');

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
app.enableShutdownHooks();
logger.info('worker iniciado');
