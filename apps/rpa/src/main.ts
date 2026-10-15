import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@abaya/config';
import { createLogger } from '@abaya/logger';
import { createChildBackend, localSettingsSchema } from './backend/child-backend.js';
import { createDirectBackend, getRobotBackend, setRobotBackend } from './backend/robot-backend.js';
import { AgentFile } from './child/agent-file.js';
import { GatewayClient } from './child/gateway-client.js';
import { EXIT, RobotRefusedError, onShutdownRequest, requestShutdown } from './lifecycle.js';
import { msUntilStart, parseWorkHours } from './schedule/work-hours.js';

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

  await waitForShift();

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

/**
 * Horario (D-026): fuera del turno no se abre Abaya. Se vuelve a consultar cada minuto (se cambia
 * en el panel) y, al llegar la hora de inicio, el robot sigue arrancando.
 */
async function waitForShift() {
  const backend = getRobotBackend();
  if (!backend) return;
  let announced: string | null | undefined;
  for (;;) {
    let raw: string | null = null;
    let wait: number;
    try {
      raw = await backend.workHours();
      const hours = parseWorkHours(raw);
      wait = hours ? msUntilStart(hours, new Date()) : 0;
    } catch (err) {
      // Sin respuesta del servidor (o un horario ilegible): no trabaja a ciegas; reintenta.
      logger.warn({ err: err instanceof Error ? err.message : 'error' }, 'no se leyó el horario');
      wait = 60_000;
    }
    if (wait <= 0) return;
    if (raw !== announced) {
      logger.info({ horario: raw }, 'fuera del horario: el robot espera sin abrir Abaya');
      announced = raw;
    }
    await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
  }
}
