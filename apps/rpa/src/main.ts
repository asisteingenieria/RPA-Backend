import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@abaya/config';
import { createLogger } from '@abaya/logger';
import { createChildBackend, localSettingsSchema } from './backend/child-backend.js';
import { createDirectBackend, setRobotBackend } from './backend/robot-backend.js';
import { AgentFile } from './child/agent-file.js';
import { GatewayClient } from './child/gateway-client.js';
import { EXIT, RobotRefusedError, onShutdownRequest, requestShutdown } from './lifecycle.js';

const logger = createLogger('rpa');

try {
  // Robot hijo (v1.6): con robot.json, todo pasa por la pasarela del servidor por HTTPS.
  // Sin él, modo directo con .env (desarrollo, pruebas y demo).
  const agentPath = resolve(process.env.ROBOT_AGENT_FILE || 'robot.json');
  let port: number;
  if (AgentFile.exists(agentPath)) {
    const local = localSettingsSchema.parse(process.env);
    const agent = await AgentFile.open(agentPath);
    const client = new GatewayClient(agent, createLogger('rpa.gateway'));
    client.onRefused = () => requestShutdown(EXIT.NO_RESTART);
    setRobotBackend(await createChildBackend(client, agent, local));
    port = local.RPA_PORT;
    logger.info({ robotUser: agent.robotUser }, 'robot hijo conectado al servidor');
  } else {
    setRobotBackend(createDirectBackend());
    port = loadConfig().RPA_PORT;
  }

  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  onShutdownRequest((code) => {
    void app.close().finally(() => process.exit(code));
  });
  await app.listen(port);
  logger.info({ port }, 'rpa escuchando');
} catch (err) {
  logger.error({ err: err instanceof Error ? err.message : 'error' }, 'el robot no pudo arrancar');
  process.exit(err instanceof RobotRefusedError ? EXIT.NO_RESTART : EXIT.ERROR);
}
