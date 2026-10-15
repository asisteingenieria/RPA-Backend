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
import { formatMinute, msUntilStart, parseWorkHours } from './schedule/work-hours.js';

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
 * Horario (15/10/2026): fuera del turno no se abre Abaya. Se espera a la hora de inicio y se sale
 * con EXIT.SHIFT: el lanzador vuelve a arrancar el robot enseguida, con conexión nueva.
 */
async function waitForShift() {
  const backend = getRobotBackend();
  let wait: number;
  let detail: Record<string, string>;
  try {
    const hours = parseWorkHours(backend?.workHours);
    if (!hours) return;
    wait = msUntilStart(hours, new Date());
    detail = { inicio: formatMinute(hours.start), fin: formatMinute(hours.end) };
  } catch (err) {
    // Horario mal escrito en el servidor: no trabaja a ciegas; vuelve a mirar en 10 minutos.
    logger.error({ err: err instanceof Error ? err.message : 'error' }, 'horario inválido');
    wait = 10 * 60_000;
    detail = {};
  }
  if (wait <= 0) return;
  logger.info(detail, 'fuera del horario: el robot espera la hora de inicio sin abrir Abaya');
  await backend?.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, wait));
  process.exit(EXIT.SHIFT);
}
