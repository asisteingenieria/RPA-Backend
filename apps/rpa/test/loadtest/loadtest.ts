/* eslint-disable no-console -- script de línea de comandos */
/**
 * Prueba de carga del bloque 1 (v1.5, sección 2.7 del plan): N robots × 3 chats simultáneos.
 *
 *   pnpm build && pnpm loadtest                       # 3 robots × 3 chats, 10 min
 *   pnpm loadtest -- --robots 2 --chats 3 --minutos 5 --latencia-llm 2000
 *
 * Levanta, sin tocar la base de desarrollo:
 * - Una base aparte `abaya_rpa_carga` (se crea, migra, carga el catálogo y se borra al final).
 * - Un Abaya simulado por robot, el worker real (LLM simulado con latencia) y un proceso rpa
 *   real por robot (Chromium sin ventana).
 * - Clientes simulados: cada robot tiene siempre `--chats` conversaciones abiertas a la vez; al
 *   terminar una venta entra otro cliente.
 *
 * Mide el tiempo que percibe el cliente (de su mensaje a la respuesta en Abaya) y verifica:
 * 0 mensajes en chat equivocado, 0 duplicados, 0 perdidos. Criterio: p95 < 15 s, p99 < 25 s.
 * Requiere: DATABASE_URL en .env con un usuario que pueda crear bases (CREATEDB) y Redis.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cipherFromConfig, sha256 } from '@abaya/crypto';
import { createPrismaClient, type PrismaClient } from '@abaya/db';
import { outboundAad } from '@abaya/domain';
import { Redis } from 'ioredis';
import { AgentFile } from '../../src/child/agent-file.js';
import { enrollWithCode } from '../../src/child/gateway-client.js';
import { defaultProtector } from '../../src/child/protector.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// ---------- parámetros ----------

const args = process.argv.slice(2);
const num = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const ROBOTS = num('robots', 3);
const CHATS = num('chats', 3);
const MINUTES = num('minutos', 10);
const LLM_DELAY_MS = num('latencia-llm', 1500);
const KEEP = args.includes('--conservar');
/** hijo (por defecto, v1.6): robots por la pasarela, sin base de datos, Redis ni clave. */
const MODE = args.includes('--modo') ? args[args.indexOf('--modo') + 1] : 'hijo';
if (MODE !== 'hijo' && MODE !== 'directo') throw new Error('--modo debe ser hijo o directo');
const TOKEN_TTL_S = num('ttl-token', 3600);
const API_PORT = 3300;
const P95_GOAL_MS = 15_000;
const P99_GOAL_MS = 25_000;
const REPLY_TIMEOUT_MS = 60_000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const isWin = process.platform === 'win32';

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
  } catch {
    // sin .env
  }
  return env;
}
const fileEnv = { ...readEnv(), ...process.env } as Record<string, string>;
if (!fileEnv.DATABASE_URL || !fileEnv.FIELD_ENCRYPTION_KEY) {
  console.error('Faltan DATABASE_URL y FIELD_ENCRYPTION_KEY en .env');
  process.exit(1);
}
const dbUrl = new URL(fileEnv.DATABASE_URL);
dbUrl.pathname = '/abaya_rpa_carga';
const DB = dbUrl.toString();
const REDIS = fileEnv.LOADTEST_REDIS_URL ?? 'redis://localhost:6380/3';

// Guiones sintéticos (caminos felices de la suite de evaluación).
const SCRIPTS = [
  [
    'Hola',
    'A',
    'Me llamo Laura',
    'Tengo Movistar',
    'Uso mucho WhatsApp, Instagram y TikTok',
    'Me gusta, quiero ese plan',
    'SÍ AUTORIZO',
  ],
  ['Hola', 'B', 'Mi nombre es Sofía', 'redes sociales y música', 'Quiero ese', 'SÍ AUTORIZO'],
  ['Hola', 'C', 'Valentina', 'para mi hija, redes y tareas', 'me sirve, lo tomo', 'SÍ AUTORIZO'],
];

// ---------- utilidades ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);

function run(cmd: string, cmdArgs: string[], cwd: string, env: Record<string, string>) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`Falló: ${cmd} ${cmdArgs.join(' ')}`);
}

const children: ChildProcess[] = [];
/** Variables que un robot hijo NUNCA debe tener (v1.6). */
const SERVER_ONLY = [
  'DATABASE_URL',
  'REDIS_URL',
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_KEY_ID',
  'FIELD_ENCRYPTION_PREVIOUS_KEYS',
];

function start(
  name: string,
  cwd: string,
  env: Record<string, string>,
  logFile: string,
  opts: { withEnvFile?: boolean } = {},
) {
  const base: Record<string, string | undefined> = { ...process.env };
  if (opts.withEnvFile === false) for (const k of SERVER_ONLY) delete base[k];
  const child = spawn(
    process.execPath,
    [...(opts.withEnvFile === false ? [] : ['--env-file-if-exists=../../.env']), 'dist/main.js'],
    { cwd, env: { ...base, ...env } },
  );
  const out: string[] = [];
  const keep = (d: Buffer) => {
    out.push(String(d));
    if (out.length > 4000) out.splice(0, 1000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => {
    writeFileSync(logFile, out.join(''));
    if (!stopping)
      console.error(`[carga] ${name} terminó inesperadamente (${code}); ver ${logFile}`);
  });
  children.push(child);
  return child;
}
let stopping = false;

// ---------- clientes simulados ----------

interface Sample {
  robot: number;
  chatId: string;
  turn: number;
  ms: number;
}
const samples: Sample[] = [];
const timeouts: { chatId: string; turn: number; at: string }[] = [];
let completed = 0;
/** Chats que no salieron de la bandeja al terminar el guion (no deberían existir). */
const notFinished: string[] = [];

function agentCount(mock: MockAbayaServer, chatId: string): number {
  const chat = mock.chat(chatId) ?? mock.history.find((c) => c.id === chatId);
  return chat?.messages.filter((m) => m.sender === 'agent').length ?? 0;
}

async function customer(mock: MockAbayaServer, robot: number, chatId: string, script: string[]) {
  for (const [turn, text] of script.entries()) {
    const before = agentCount(mock, chatId);
    const t0 = Date.now();
    mock.addCustomerMessage(chatId, text);
    // Esperar la primera respuesta del robot.
    while (agentCount(mock, chatId) === before) {
      if (Date.now() - t0 > REPLY_TIMEOUT_MS) {
        timeouts.push({ chatId, turn, at: new Date(t0).toISOString() });
        return;
      }
      await sleep(100);
    }
    samples.push({ robot, chatId, turn, ms: Date.now() - t0 });
    // El robot puede mandar varios mensajes en un turno: esperar 1,5 s sin nuevos.
    let last = agentCount(mock, chatId);
    let quietSince = Date.now();
    while (Date.now() - quietSince < 1_500) {
      await sleep(100);
      const n = agentCount(mock, chatId);
      if (n !== last) {
        last = n;
        quietSince = Date.now();
      }
    }
    if (!mock.chat(chatId)) break; // ya lo transfirió o cerró
    await sleep(rand(1_000, 4_000)); // el cliente lee y escribe
  }
  // Esperar a que la venta salga de la bandeja (transferencia al backoffice).
  const t0 = Date.now();
  while (mock.chat(chatId) && Date.now() - t0 < REPLY_TIMEOUT_MS) await sleep(200);
  if (mock.chat(chatId)) notFinished.push(chatId);
  else completed++;
}

// ---------- verificación ----------

async function verify(prisma: PrismaClient, mocks: MockAbayaServer[]) {
  const cipher = cipherFromConfig({
    FIELD_ENCRYPTION_KEY: fileEnv.FIELD_ENCRYPTION_KEY!,
    FIELD_ENCRYPTION_KEY_ID: Number(fileEnv.FIELD_ENCRYPTION_KEY_ID ?? 1),
    FIELD_ENCRYPTION_PREVIOUS_KEYS: fileEnv.FIELD_ENCRYPTION_PREVIOUS_KEYS,
  });
  const convs = await prisma.conversation.findMany({ include: { messages: true } });
  const byChat = new Map(convs.map((c) => [c.abayaChatId, c]));
  let wrongChat = 0;
  let duplicates = 0;
  let missing = 0;
  for (const mock of mocks) {
    const posted = new Map<string, string[]>();
    for (const p of mock.agentPosts)
      posted.set(p.chatId, [...(posted.get(p.chatId) ?? []), p.text]);
    for (const [chatId, texts] of posted) {
      const conv = byChat.get(chatId);
      if (!conv || conv.robotUser !== mock.username) {
        wrongChat += texts.length;
        continue;
      }
      // Lo que el robot escribió en este chat debe ser exactamente lo que el motor generó para él.
      const expected = conv.messages
        .filter((m) => m.direction === 'OUTBOUND' && m.status === 'SENT_VERIFIED')
        .map((m) => cipher.decryptString(m.bodyEncrypted, outboundAad(m.idempotencyKey ?? '')));
      const pool = [...expected];
      for (const t of texts) {
        const i = pool.indexOf(t);
        if (i >= 0) pool.splice(i, 1);
        else if (expected.includes(t)) duplicates++;
        else wrongChat++;
      }
      missing += pool.length;
    }
  }
  const unprocessed = await prisma.message.count({
    where: { direction: 'INBOUND', processedAt: null },
  });
  const customerMsgs = mocks.reduce(
    (a, m) =>
      a +
      [...m.chats, ...m.history].reduce(
        (b, c) => b + c.messages.filter((x) => x.sender === 'customer').length,
        0,
      ),
    0,
  );
  const storedInbound = convs.reduce(
    (a, c) => a + c.messages.filter((m) => m.direction === 'INBOUND').length,
    0,
  );
  return {
    wrongChat,
    duplicates,
    missing,
    unprocessed,
    customerMsgs,
    storedInbound,
    uncertain: await prisma.message.count({ where: { status: 'UNCERTAIN' } }),
    needsReview: await prisma.conversation.count({ where: { status: 'NEEDS_REVIEW' } }),
    sales: await prisma.sale.count(),
    // El robot solo abre un chat "suelto" (OPEN_CHAT) desde el barrido de mensajes perdidos.
    recoveredBySweep: await prisma.rpaActionLog.count({
      where: { action: 'OPEN_CHAT', result: 'OK' },
    }),
    transferred: mocks.reduce((a, m) => a + m.transfers.length, 0),
  };
}

// ---------- principal ----------

async function main() {
  console.log(
    `[carga] ${ROBOTS} robots × ${CHATS} chats simultáneos · ${MINUTES} min · LLM simulado ~${LLM_DELAY_MS} ms · modo ${MODE}`,
  );

  // 1. Base aparte y Redis aparte.
  const require = createRequire(join(ROOT, 'packages/db/package.json'));
  const pg = require('pg') as {
    Client: new (o: { connectionString: string }) => {
      connect(): Promise<void>;
      query(q: string): Promise<unknown>;
      end(): Promise<void>;
    };
  };
  const admin = new URL(fileEnv.DATABASE_URL!);
  admin.pathname = '/postgres';
  const pgc = new pg.Client({ connectionString: admin.toString() });
  await pgc.connect();
  await pgc.query('DROP DATABASE IF EXISTS abaya_rpa_carga WITH (FORCE)');
  await pgc.query('CREATE DATABASE abaya_rpa_carga');
  await pgc.end();
  run('npx', ['prisma', 'migrate', 'deploy'], join(ROOT, 'packages/db'), { DATABASE_URL: DB });
  run(
    'npx',
    ['tsx', 'src/catalog/seed.ts', 'src/catalog/plans.synthetic.csv'],
    join(ROOT, 'apps/worker'),
    {
      ...fileEnv,
      DATABASE_URL: DB,
      REDIS_URL: REDIS,
    },
  );
  const redis = new Redis(REDIS, { maxRetriesPerRequest: 1 });
  await redis.flushdb();

  // 2. Abaya simulado por robot.
  const mocks: MockAbayaServer[] = [];
  for (let r = 0; r < ROBOTS; r++) {
    const mock = new MockAbayaServer({ username: `robot-carga-${r + 1}`, chats: [] });
    await mock.start(4100 + r);
    mocks.push(mock);
  }

  // 3. Procesos reales.
  const work = mkdtempSync(join(tmpdir(), 'abaya-carga-'));
  const common = {
    DATABASE_URL: DB,
    REDIS_URL: REDIS,
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    ROBOT_AGENT_FILE: join(work, 'no-existe.json'), // modo .env, no hijo
  };
  start(
    'worker',
    join(ROOT, 'apps/worker'),
    { ...common, LLM_PROVIDER: 'simulado', LLM_SIMULATED_DELAY_MS: String(LLM_DELAY_MS) },
    join(work, 'worker.log'),
  );
  const prisma = createPrismaClient(DB);
  const cipher = cipherFromConfig({
    FIELD_ENCRYPTION_KEY: fileEnv.FIELD_ENCRYPTION_KEY!,
    FIELD_ENCRYPTION_KEY_ID: Number(fileEnv.FIELD_ENCRYPTION_KEY_ID ?? 1),
    FIELD_ENCRYPTION_PREVIOUS_KEYS: fileEnv.FIELD_ENCRYPTION_PREVIOUS_KEYS,
  });
  if (MODE === 'hijo') {
    // Servidor padre con la pasarela (tokens de acceso de TOKEN_TTL_S segundos).
    start(
      'api',
      join(ROOT, 'apps/api'),
      {
        ...common,
        API_PORT: String(API_PORT),
        ABAYA_BASE_URL: mocks[0]!.url, // cada robot usa su Abaya simulado (ROBOT_DEV_ABAYA_BASE_URL)
        ADMIN_COOKIE_SECURE: 'false',
        TRACE_DIR: join(work, 'trazas-servidor'),
        ROBOT_ACCESS_TTL_MS: String(TOKEN_TTL_S * 1000),
      },
      join(work, 'api.log'),
    );
    const server = `http://127.0.0.1:${API_PORT}`;
    for (let i = 0; ; i++) {
      if (
        await fetch(`${server}/health`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      if (i > 60) throw new Error('la api no arrancó');
      await sleep(500);
    }
    // Alta e instalación de cada robot como en producción: código de un solo uso → robot.json.
    for (let r = 0; r < ROBOTS; r++) {
      const robotUser = mocks[r]!.username;
      const code = `CARGA${r + 1}`.padEnd(12, 'X');
      await prisma.robot.create({
        data: {
          robotUser,
          abayaPasswordEncrypted: new Uint8Array(
            cipher.encrypt(mocks[r]!.password, `robot:${robotUser}`),
          ),
          enrollmentCodeHash: sha256(code),
          enrollmentExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const enrolled = await enrollWithCode({ server, code, host: `CARGA-${r + 1}` });
      await AgentFile.create(join(work, `robot-${r + 1}.json`), defaultProtector(), {
        server,
        ...enrolled,
      });
    }
  }
  for (let r = 0; r < ROBOTS; r++) {
    mkdirSync(join(work, `robot-${r + 1}`), { recursive: true });
    const local = {
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      ABAYA_HEADLESS: 'true',
      RPA_PORT: String(3200 + r),
      ROBOT_HOST: `CARGA-${r + 1}`,
      SESSION_STATE_DIR: join(work, `robot-${r + 1}`),
      TRACE_DIR: join(work, `robot-${r + 1}`, 'trazas'),
    };
    if (MODE === 'hijo') {
      start(
        `rpa-${r + 1}`,
        join(ROOT, 'apps/rpa'),
        {
          ...local,
          ROBOT_AGENT_FILE: join(work, `robot-${r + 1}.json`),
          ROBOT_DEV_ABAYA_BASE_URL: mocks[r]!.url,
          ...(process.platform === 'win32' ? {} : { ROBOT_ALLOW_UNPROTECTED: '1' }),
        },
        join(work, `rpa-${r + 1}.log`),
        { withEnvFile: false },
      );
    } else {
      start(
        `rpa-${r + 1}`,
        join(ROOT, 'apps/rpa'),
        {
          ...common,
          ...local,
          ABAYA_BASE_URL: mocks[r]!.url,
          ABAYA_USER: mocks[r]!.username,
          ABAYA_PASSWORD: mocks[r]!.password,
          ABAYA_MFA_MODE: 'none',
        },
        join(work, `rpa-${r + 1}.log`),
      );
    }
  }

  try {
    // 4. Esperar a que todos los robots tengan sesión en Abaya.
    const t0 = Date.now();
    while (true) {
      const active = await prisma.rpaSession.count({ where: { status: 'ACTIVE' } });
      if (active === ROBOTS) break;
      if (Date.now() - t0 > 120_000) throw new Error(`Solo ${active}/${ROBOTS} robots activos`);
      await sleep(1_000);
    }
    console.log(`[carga] ${ROBOTS} robots en línea; empiezan los clientes`);

    // 5. Clientes: siempre CHATS conversaciones abiertas por robot.
    const deadline = Date.now() + MINUTES * 60_000;
    let seq = 0;
    const lanes: Promise<void>[] = [];
    for (let r = 0; r < ROBOTS; r++) {
      for (let s = 0; s < CHATS; s++) {
        lanes.push(
          (async () => {
            while (Date.now() < deadline) {
              const id = ++seq;
              await customer(mocks[r]!, r + 1, `R${r + 1}-C${id}`, SCRIPTS[id % SCRIPTS.length]!);
            }
          })(),
        );
      }
    }
    const progress = setInterval(() => {
      const ms = samples.map((x) => x.ms);
      console.log(
        `[carga] respuestas ${ms.length} · p50 ${fmt(pct(ms, 50))} · p95 ${fmt(pct(ms, 95))} · ventas completas ${completed} · sin respuesta ${timeouts.length}`,
      );
    }, 30_000);
    await Promise.all(lanes);
    clearInterval(progress);
    await sleep(5_000); // últimas confirmaciones

    // 6. Resultados.
    const v = await verify(prisma, mocks);
    const tokenInfo = (
      await prisma.robot.findMany({ select: { robotUser: true, tokenRotatedAt: true } })
    )
      .map(
        (x) =>
          `${x.robotUser} rotó hace ${x.tokenRotatedAt ? Math.round((Date.now() - x.tokenRotatedAt.getTime()) / 1000) : '—'} s`,
      )
      .join(', ');
    const ms = samples.map((x) => x.ms);
    const p50 = pct(ms, 50);
    const p95 = pct(ms, 95);
    const p99 = pct(ms, 99);
    const perRobot = Array.from({ length: ROBOTS }, (_, r) => {
      const xs = samples.filter((x) => x.robot === r + 1).map((x) => x.ms);
      return {
        robot: `robot-carga-${r + 1}`,
        n: xs.length,
        p50: pct(xs, 50),
        p95: pct(xs, 95),
        max: pct(xs, 100),
      };
    });
    const checks = [
      ['Mensajes en chat equivocado', v.wrongChat, v.wrongChat === 0],
      ['Mensajes duplicados', v.duplicates, v.duplicates === 0],
      ['Respuestas generadas que no llegaron', v.missing, v.missing === 0],
      [
        'Mensajes del cliente guardados / enviados',
        `${v.storedInbound} / ${v.customerMsgs}`,
        v.storedInbound === v.customerMsgs,
      ],
      ['Mensajes del cliente sin atender', v.unprocessed, v.unprocessed === 0],
      ['Turnos sin respuesta en 60 s', timeouts.length, timeouts.length === 0],
      ['Ventas que no salieron de la bandeja', notFinished.length, notFinished.length === 0],
      ['Envíos inciertos', v.uncertain, v.uncertain === 0],
      ['Conversaciones en revisión', v.needsReview, v.needsReview === 0],
      ['p95 del tiempo de respuesta', fmt(p95), p95 !== null && p95 < P95_GOAL_MS],
      ['p99 del tiempo de respuesta', fmt(p99), p99 !== null && p99 < P99_GOAL_MS],
    ] as const;
    const ok = checks.every((c) => c[2]);
    const report = [
      `# Prueba de carga — ${new Date().toISOString()}`,
      '',
      `${ROBOTS} robots × ${CHATS} chats simultáneos · ${MINUTES} min · LLM simulado ~${LLM_DELAY_MS} ms (±50 %) · ráfaga 4 s`,
      MODE === 'hijo'
        ? `Modo **hijo** (v1.6): robots por la pasarela HTTPS, sin base de datos, Redis ni clave de cifrado; robot.json ${process.platform === 'win32' ? 'protegido con DPAPI' : 'sin DPAPI'}; tokens de acceso de ${TOKEN_TTL_S} s (renovaciones en plena carga: ${tokenInfo}).`
        : 'Modo **directo** (desarrollo).',
      '',
      `**Resultado: ${ok ? 'APROBADA' : 'NO APROBADA'}**`,
      '',
      '| Verificación | Valor | OK |',
      '| --- | --- | --- |',
      ...checks.map(([k, val, pass]) => `| ${k} | ${val} | ${pass ? '✅' : '❌'} |`),
      '',
      `Respuestas medidas: ${ms.length} · p50 ${fmt(p50)} · p95 ${fmt(p95)} · p99 ${fmt(p99)} · máx ${fmt(pct(ms, 100))}`,
      `Ventas completas: ${completed} · ventas registradas: ${v.sales} · transferidas en Abaya: ${v.transferred}`,
      `Chats recuperados por el barrido de mensajes no detectados: ${v.recoveredBySweep}`,
      '',
      '| Robot | Respuestas | p50 | p95 | Máx |',
      '| --- | --- | --- | --- | --- |',
      ...perRobot.map(
        (r) => `| ${r.robot} | ${r.n} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} |`,
      ),
      '',
      'El tiempo incluye la espera de ráfaga (4 s), el motor y el envío confirmado por Abaya.',
      ...(timeouts.length
        ? [
            '',
            'Turnos sin respuesta (chat · turno · enviado):',
            ...timeouts.map((t) => `- ${t.chatId} · ${t.turn} · ${t.at}`),
          ]
        : []),
    ].join('\n');
    const dir = join(ROOT, 'apps/rpa/test/loadtest/reports');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    writeFileSync(file, report + '\n');
    console.log('\n' + report + `\n\nReporte: ${file}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    stopping = true;
    for (const c of children) c.kill();
    await sleep(3_000);
    await prisma.$disconnect();
    for (const m of mocks) await m.stop();
    await redis.flushdb().catch(() => undefined);
    await redis.quit();
    if (!KEEP) {
      const pgc2 = new pg.Client({ connectionString: admin.toString() });
      await pgc2.connect();
      await pgc2.query('DROP DATABASE IF EXISTS abaya_rpa_carga WITH (FORCE)');
      await pgc2.end();
      rmSync(work, { recursive: true, force: true });
    } else {
      console.log(`[carga] base abaya_rpa_carga y registros conservados en ${work}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  stopping = true;
  for (const c of children) c.kill();
  process.exit(1);
});
