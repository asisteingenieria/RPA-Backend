#!/usr/bin/env node
/**
 * D-050: corre un comando de consola con los secretos de la bóveda en su entorno.
 *
 *   node packages/config/dist/with-secrets.js pnpm --filter @abaya/db migrate:deploy
 *
 * Carga el `.env` de la carpeta actual si existe (como las apps) y después la bóveda.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadSecretsIntoEnv } from './secrets.js';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  process.stderr.write('Uso: node packages/config/dist/with-secrets.js <comando> [argumentos…]\n');
  process.exit(2);
}
if (existsSync('.env')) process.loadEnvFile('.env');
// En consola no se espera para siempre: 5 intentos y sigue con el .env.
await loadSecretsIntoEnv({ maxAttempts: 5 });

// En Windows `pnpm` es un .cmd y necesita shell: se arma una sola línea con los argumentos entre
// comillas. En Linux (el servidor) se ejecuta directo, sin shell.
const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const child =
  process.platform === 'win32'
    ? spawn([cmd, ...args].map(quote).join(' '), {
        stdio: 'inherit',
        env: process.env,
        shell: true,
      })
    : spawn(cmd, args, { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
child.on('error', (e) => {
  process.stderr.write(`No se pudo ejecutar «${cmd}»: ${e.message}\n`);
  process.exit(1);
});
