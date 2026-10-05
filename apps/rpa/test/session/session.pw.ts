import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FieldCipher, totp } from '@abaya/crypto';
import { createLogger } from '@abaya/logger';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemorySessionRepository } from '../../src/session/session.repository.js';
import { EncryptedFileStorageStateStore } from '../../src/session/storage-state.store.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// E2E de F2 contra el Abaya simulado con Chromium real.
// Tiempos escalados (heartbeat 500 ms, esperas de 200 ms) para que la prueba sea rápida;
// los valores de producción (30 s y 5/15/45 s) se prueban en las pruebas unitarias.

test.describe.configure({ mode: 'serial' });

const cipher = new FieldCipher(randomBytes(32).toString('base64'));

async function makeManager(
  mock: MockAbayaServer,
  opts: { password?: string; dir?: string; totpSecret?: string } = {},
) {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), 'abaya-e2e-')));
  const store = new EncryptedFileStorageStateStore(dir, mock.username, cipher);
  const repo = new MemorySessionRepository();
  const alerts = new MemoryAlertAdapter();
  const gate = new ActorGate();
  let recovered = 0;
  const mgr = new SessionManager({
    robotUser: mock.username,
    driver: new PlaywrightSessionDriver({ baseUrl: mock.url, headless: true }),
    store,
    repo,
    alerts,
    gate,
    logger: createLogger('e2e', { level: 'silent' }),
    credentials: () => ({
      username: mock.username,
      password: opts.password ?? mock.password,
      ...(opts.totpSecret ? { otp: totp(opts.totpSecret) } : {}),
    }),
    heartbeatMs: 500,
    backoffMs: [200, 400, 800],
    onRecovered: async () => {
      recovered++;
    },
  });
  return { mgr, store, repo, alerts, gate, dir, recovered: () => recovered };
}

let mock: MockAbayaServer;

test.beforeEach(async () => {
  mock = new MockAbayaServer();
  await mock.start();
});

test.afterEach(async () => {
  await mock.stop();
});

test('login inicial y storageState cifrado en disco', async () => {
  const t = await makeManager(mock);
  expect(await t.mgr.start()).toBe('ACTIVE');
  expect(mock.loginAttempts).toBe(1);
  expect(t.gate.isOpen()).toBe(true);
  const raw = await readFile(t.store.path);
  const sid = [...mock.sessions][0]!;
  expect(raw.toString('latin1')).not.toContain(sid);
  await t.mgr.stop();
});

test('al reiniciar reutiliza el storageState sin volver a hacer login', async () => {
  const a = await makeManager(mock);
  await a.mgr.start();
  await a.mgr.stop();

  const b = await makeManager(mock, { dir: a.dir });
  expect(await b.mgr.start()).toBe('ACTIVE');
  expect(mock.loginAttempts).toBe(1);
  await b.mgr.stop();
});

test('si se cierra la sesión a mano, vuelve a entrar solo (< 1 min)', async () => {
  const t = await makeManager(mock);
  await t.mgr.start();

  const lostAt = Date.now();
  mock.expireAllSessions();

  await expect.poll(() => mock.loginAttempts, { timeout: 60_000, intervals: [250] }).toBe(2);
  await expect.poll(() => t.mgr.status, { timeout: 60_000 }).toBe('ACTIVE');
  expect(Date.now() - lostAt).toBeLessThan(60_000);
  await expect.poll(() => t.recovered(), { timeout: 10_000 }).toBe(1);
  expect(t.gate.isOpen()).toBe(true);
  await t.mgr.stop();
});

test('con contraseña incorrecta se detiene tras 3 intentos y alerta', async () => {
  const t = await makeManager(mock, { password: 'incorrecta' });
  expect(await t.mgr.start()).toBe('DOWN');
  expect(mock.loginAttempts).toBe(3);
  expect(t.alerts.raised).toEqual([
    expect.objectContaining({ code: 'SESSION_DOWN', severity: 'CRITICA' }),
  ]);
  expect(t.gate.isOpen()).toBe(false);
  expect(JSON.stringify(t.alerts.raised)).not.toContain('incorrecta');
  await t.mgr.stop();
});

test('login con MFA por TOTP', async () => {
  await mock.stop();
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  mock = new MockAbayaServer({ totpSecret: secret });
  await mock.start();
  const t = await makeManager(mock, { totpSecret: secret });
  expect(await t.mgr.start()).toBe('ACTIVE');
  await t.mgr.stop();
});

test('@abaya login real en el ambiente de pruebas', async () => {
  // Solo con ABAYA_E2E=1 y credenciales del usuario robot en el entorno (nunca en el código).
  const { loadConfig, requireAbayaConfig } = await import('@abaya/config');
  const cfg = requireAbayaConfig(loadConfig());
  const dir = await mkdtemp(join(tmpdir(), 'abaya-real-'));
  const mgr = new SessionManager({
    robotUser: cfg.robotUser,
    driver: new PlaywrightSessionDriver({ baseUrl: cfg.baseUrl, headless: cfg.headless }),
    store: new EncryptedFileStorageStateStore(dir, cfg.robotUser, cipher),
    repo: new MemorySessionRepository(),
    alerts: new MemoryAlertAdapter(),
    gate: new ActorGate(),
    logger: createLogger('e2e-abaya'),
    credentials: () => ({
      username: cfg.robotUser,
      password: cfg.password,
      ...(cfg.totpSecret ? { otp: totp(cfg.totpSecret) } : {}),
    }),
    heartbeatMs: cfg.heartbeatMs,
  });
  expect(await mgr.start()).toBe('ACTIVE');
  await mgr.stop();
});
