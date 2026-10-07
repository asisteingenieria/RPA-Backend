#!/usr/bin/env node
/**
 * Demo local de punta a punta con Abaya SIMULADO y LLM SIMULADO (sin red ni API keys).
 *
 *   pnpm build && pnpm demo            # navegador del robot oculto
 *   pnpm build && pnpm demo --visible  # ver al robot operando Abaya
 *
 * Levanta: Abaya simulado (4010), api + panel (3000), worker y rpa. Usa una base aparte
 * `abaya_rpa_demo` (se crea, migra y carga con el catálogo sintético) y Redis base 1.
 * Requiere DATABASE_URL en .env con un usuario que pueda crear bases (CREATEDB).
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const visible = process.argv.includes('--visible');
const isWin = process.platform === 'win32';

function readEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    // sin .env
  }
  return env;
}

const fileEnv = readEnv();
const baseUrl = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('Falta DATABASE_URL en .env');
  process.exit(1);
}
const demoUrl = new URL(baseUrl);
demoUrl.pathname = '/abaya_rpa_demo';
const DEMO_DB = demoUrl.toString();

// 1. Base de datos de la demo (aparte de la de desarrollo).
const require = createRequire(join(ROOT, 'packages/db/package.json'));
const pg = require('pg');
const admin = new URL(baseUrl);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
const exists = await client.query("select 1 from pg_database where datname = 'abaya_rpa_demo'");
if (!exists.rowCount) {
  await client.query('CREATE DATABASE abaya_rpa_demo');
  console.log('[demo] base abaya_rpa_demo creada');
}
await client.end();

const run = (cmd, args, cwd, extraEnv = {}) => {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('npx', ['prisma', 'migrate', 'deploy'], join(ROOT, 'packages/db'), { DATABASE_URL: DEMO_DB });
run(
  'npx',
  ['tsx', 'src/catalog/seed.ts', 'src/catalog/plans.synthetic.json'],
  join(ROOT, 'apps/worker'),
  {
    ...fileEnv,
    DATABASE_URL: DEMO_DB,
  },
);

// La demo siempre arranca con la sesión del robot limpia (un DOWN de una corrida anterior
// impediría el login: el robot no insiste tras 3 fallos, sección 6.1).
const demoClient = new pg.Client({ connectionString: DEMO_DB });
await demoClient.connect();
await demoClient.query(`UPDATE "RpaSession" SET status = 'RELOGGING', "consecutiveFails" = 0`);
await demoClient.end();

// 2. Usuario ADMIN de la demo: cada corrida le da una contraseña temporal nueva.
const adminCli = spawnSync(
  process.execPath,
  ['--env-file-if-exists=../../.env', 'dist/cli/create-admin.js', 'admin.demo', '--reset'],
  { cwd: join(ROOT, 'apps/api'), encoding: 'utf8', env: { ...process.env, DATABASE_URL: DEMO_DB } },
);
if (adminCli.status !== 0) {
  console.error(adminCli.stderr || adminCli.stdout);
  process.exit(1);
}
const demoPassword = /temporal[^:]*: (\S+)/.exec(adminCli.stdout)?.[1] ?? '(ver arriba)';

// 3. Procesos.
const demoEnv = {
  DATABASE_URL: DEMO_DB,
  REDIS_URL: 'redis://localhost:6380/1',
  ABAYA_BASE_URL: 'http://127.0.0.1:4010',
  ABAYA_USER: 'robot-ventas-01',
  ABAYA_PASSWORD: 'clave-de-prueba',
  ABAYA_MFA_MODE: 'none',
  ABAYA_HEADLESS: visible ? 'false' : 'true',
  LLM_PROVIDER: 'simulado',
  BURST_QUIET_MS: '2000',
  HEARTBEAT_INTERVAL_MS: '10000',
  SESSION_STATE_DIR: '.secrets/demo',
  TRACE_DIR: '.secrets/demo/traces',
  // El panel de la demo corre por http://localhost (los navegadores aceptan la cookie Secure ahí).
  ADMIN_COOKIE_SECURE: 'true',
};

const children = [];
const COLORS = { abaya: 35, api: 36, worker: 33, rpa: 32 };
function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, {
    cwd,
    // Node se lanza directo (su ruta puede tener espacios); npx necesita el shell en Windows.
    shell: isWin && cmd !== process.execPath,
    // El entorno de la demo manda sobre .env (node --env-file no pisa variables existentes).
    env: { ...process.env, ...demoEnv },
  });
  const tag = `\x1b[${COLORS[name]}m[${name}]\x1b[0m `;
  const pipe = (stream) =>
    stream.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/))
        if (line.trim()) process.stdout.write(tag + line + '\n');
    });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => process.stdout.write(`${tag}terminó (${code})\n`));
  children.push(child);
}

const node = ['--env-file-if-exists=../../.env', 'dist/main.js'];
start('abaya', 'npx', ['tsx', 'test/mock-abaya/serve.ts'], join(ROOT, 'apps/rpa'));
await new Promise((r) => setTimeout(r, 2500));
start('api', process.execPath, node, join(ROOT, 'apps/api'));
start('worker', process.execPath, node, join(ROOT, 'apps/worker'));
start('rpa', process.execPath, node, join(ROOT, 'apps/rpa'));

setTimeout(() => {
  console.log(`
\x1b[1mDemo lista\x1b[0m
  Cliente simulado (escribe aquí):  http://127.0.0.1:4010/__cliente
  Panel de operación:               http://localhost:3000/panel
    usuario admin.demo · contraseña temporal ${demoPassword} (te pedirá cambiarla)
  Base de datos (pgAdmin):          abaya_rpa_demo
  Ctrl+C para detener todo.
`);
}, 6000);

const stop = () => {
  for (const c of children) c.kill();
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
