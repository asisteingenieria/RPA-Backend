/* eslint-disable no-console -- script de línea de comandos */
/**
 * Registra este equipo como robot hijo (lo usa el instalador):
 *
 *   node dist/cli/enroll.js --servidor https://servidor --codigo ABCD-EFGH-JKLM [--archivo robot.json]
 *
 * Guarda en robot.json la URL del servidor y, protegidos con DPAPI (usuario de Windows), el
 * token de renovación del equipo y su clave local. Nada más (v1.6).
 */
import { resolve } from 'node:path';
import { AgentFile } from '../child/agent-file.js';
import { enrollWithCode } from '../child/gateway-client.js';
import { defaultProtector } from '../child/protector.js';
import { robotHost } from '../presence/instance.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const server = arg('servidor');
const code = arg('codigo');
const file = resolve(arg('archivo') ?? process.env.ROBOT_AGENT_FILE ?? 'robot.json');
if (!server || !code) {
  console.error('Uso: enroll --servidor <url> --codigo <código> [--archivo robot.json]');
  process.exit(2);
}

try {
  const allowHttp = process.argv.includes('--permitir-http');
  if (allowHttp) process.env.ROBOT_ALLOW_HTTP = '1';
  const r = await enrollWithCode({
    server,
    code,
    host: robotHost(process.env.ROBOT_HOST),
    allowHttp,
  });
  const protector = defaultProtector();
  await AgentFile.create(file, protector, { server, ...r });
  console.log(
    `Equipo registrado como ${r.robotUser}. Configuración guardada en ${file}` +
      (protector.kind === 'dpapi' ? ' (protegida con DPAPI)' : ' (SIN protección DPAPI)'),
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : 'No se pudo registrar el equipo');
  process.exitCode = 1;
}
