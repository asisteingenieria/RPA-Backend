/* eslint-disable no-console -- script de línea de comandos */
/**
 * Diagnóstico de Abaya por pasos (D-020, docs/runbook.md 8.e).
 *
 *   probar-abaya <paso> [--ver] [--dejar-abierto]
 *
 * Pasos: url · login · estado · disponible · bandeja (cada uno corre los anteriores).
 * `--ver` abre el navegador visible. Con robot.json (equipo robot) las credenciales llegan de
 * la pasarela del servidor, como al robot; sin él, del .env (modo directo, desarrollo).
 * `--dejar-abierto` (implica `--ver`): al terminar no hace «Salir» ni cierra el navegador; el
 * diagnóstico termina cuando la persona cierra la ventana (antes debe salir de Abaya a mano).
 * El robot no puede estar en línea al mismo tiempo: el diagnóstico lo reclama como el robot.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { totp } from '@abaya/crypto';
import { loadConfig } from '@abaya/config';
import { createLogger } from '@abaya/logger';
import { ActorGate } from '../actor/actor-gate.js';
import { BrowserActor } from '../actor/browser-actor.js';
import { createChildBackend, localSettingsSchema } from '../backend/child-backend.js';
import { createDirectBackend, type RobotBackend } from '../backend/robot-backend.js';
import { AgentFile } from '../child/agent-file.js';
import { GatewayClient } from '../child/gateway-client.js';
import {
  AbayaDiagnostic,
  STEP_HELP,
  STEPS,
  type Step,
  type StepResult,
} from '../diagnostics/abaya-diagnostic.js';
import { robotHost, robotVersion } from '../presence/instance.js';
import { RobotPresence } from '../presence/robot-presence.js';
import { ChatIdentityGuard } from '../safety/chat-identity-guard.js';
import { PlaywrightSessionDriver } from '../session/playwright-session-driver.js';

// La consola muestra solo los pasos; los logs del robot, solo si algo anda mal (aunque el .env
// pida más detalle: ese nivel es para el robot).
process.env.LOG_LEVEL = 'warn';

const args = process.argv.slice(2).filter((a) => a !== '--');
const step = args.find((a) => !a.startsWith('--')) as Step | undefined;
const keepOpen = args.includes('--dejar-abierto');
const visible = keepOpen || args.includes('--ver');
if (!step || !STEPS.includes(step)) {
  console.error('Uso: probar-abaya <paso> [--ver] [--dejar-abierto]\n');
  for (const s of STEPS) console.error(`  ${s.padEnd(11)} ${STEP_HELP[s]}`);
  console.error('\nCada paso corre los anteriores. --ver muestra el navegador.');
  console.error(
    '--dejar-abierto deja la ventana abierta al terminar (usted cierra sesión y la cierra).',
  );
  process.exit(2);
}

const logger = createLogger('rpa.diagnostico');

async function openBackend(): Promise<{ backend: RobotBackend; client?: GatewayClient }> {
  const agentPath = resolve(process.env.ROBOT_AGENT_FILE || 'robot.json');
  if (AgentFile.exists(agentPath)) {
    const agent = await AgentFile.open(agentPath);
    const client = new GatewayClient(agent, createLogger('rpa.gateway'));
    const local = localSettingsSchema.parse(process.env);
    return { backend: await createChildBackend(client, agent, local), client };
  }
  loadConfig(); // valida el .env antes de abrir nada
  const backend = createDirectBackend();
  if (!backend) throw new Error('ABAYA_BASE_URL no está configurada');
  return { backend };
}

/** En el equipo robot el kill switch llega por el WebSocket: esperar a estar conectado. */
async function waitConnected(backend: RobotBackend, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && (await backend.killSwitch.isActive())) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

function print(r: StepResult) {
  const mark = r.ok ? '[OK]   ' : '[FALLA]';
  console.log(
    `${mark} ${r.step.padEnd(11)} ${(r.ms / 1000).toFixed(1).padStart(5)} s  ${r.detail}`,
  );
}

let presence: RobotPresence | undefined;
let backend: RobotBackend | undefined;
let exitCode = 1;
try {
  const opened = await openBackend();
  backend = opened.backend;
  const { abaya, alerts } = backend;
  console.log(`Diagnóstico de Abaya · robot ${abaya.robotUser} · ${abaya.baseUrl}\n`);

  // Un robot = un equipo a la vez: si el robot está en línea, el diagnóstico no arranca.
  const instanceId = randomUUID();
  presence = new RobotPresence({
    store: backend.presence,
    info: {
      robotUser: abaya.robotUser,
      instanceId,
      host: robotHost(backend.robotHost),
      version: `${robotVersion()}-diagnostico`,
    },
    alerts,
    logger,
    onEvicted: () => {
      console.error('\nEl servidor retiró el robot (deshabilitado o tomado por otro equipo).');
      process.exit(3);
    },
  });
  await presence.start();
  if (backend.mode === 'child') {
    // El WebSocket trae el kill switch y la pausa. El diagnóstico no atiende tareas: si llega
    // una (envío, transferencia, cierre), se rechaza y el servidor la deja para el robot.
    const refuse = () => Promise.reject(new Error('robot en diagnóstico: no atiende tareas'));
    await backend.startQueues({ send: refuse, transfer: refuse, close: refuse }, instanceId);
    await waitConnected(backend);
  }

  const driver = new PlaywrightSessionDriver({
    baseUrl: abaya.baseUrl,
    headless: visible ? false : abaya.headless,
    goAvailable: false,
  });
  const actor = new BrowserActor({
    robotUser: abaya.robotUser,
    page: () => driver.page,
    gate: new ActorGate(),
    killSwitch: backend.killSwitch,
    guard: new ChatIdentityGuard(),
    actionLog: backend.actionLog,
    outbound: backend.outbound,
    alerts,
    logger: createLogger('rpa.actor'),
  });
  const results = await new AbayaDiagnostic({
    robotUser: abaya.robotUser,
    driver,
    actor,
    killSwitch: backend.killSwitch,
    actionLog: backend.actionLog,
    credentials: () => ({
      username: abaya.robotUser,
      password: abaya.password,
      ...(abaya.mfaMode === 'totp' && abaya.totpSecret ? { otp: totp(abaya.totpSecret) } : {}),
    }),
    onStep: print,
    onLogout: (ok) =>
      console.log(
        ok
          ? '\nSesión cerrada en Abaya (Salir).'
          : '\nATENCIÓN: no se pudo cerrar la sesión en Abaya. Ciérrela a mano (avatar → Salir) antes de volver a probar.',
      ),
    keepOpen,
  }).run(step);

  const failed = results.find((r) => !r.ok);
  console.log(
    failed
      ? `\nFalló en «${failed.step}». Los pasos siguientes no se probaron.`
      : `\nTodo bien hasta «${step}».`,
  );
  exitCode = failed ? 1 : 0;
  if (keepOpen) {
    console.log(
      '\nLa ventana del navegador queda abierta. Para terminar:\n' +
        '  1. En Abaya cierre sesión: iniciales arriba a la derecha → ícono de apagado → ACEPTAR.\n' +
        '  2. Cierre la ventana del navegador.\n' +
        'Si la cierra sin cerrar sesión, Abaya no dejará volver a entrar («ya se encuentra conectado»).',
    );
    await driver.waitUntilClosed();
    await driver.close();
    console.log('Ventana cerrada. Fin del diagnóstico.');
  }
} catch (err) {
  console.error(
    `\nNo se pudo correr el diagnóstico: ${err instanceof Error ? err.message : 'error'}`,
  );
} finally {
  await presence?.stop().catch(() => undefined);
  await backend?.close().catch(() => undefined);
}
process.exit(exitCode);
