import { MemoryAlertAdapter } from '@abaya/alerts';
import { createLogger } from '@abaya/logger';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { BrowserActor } from '../../src/actor/browser-actor.js';
import { MemoryActionLog } from '../../src/audit/action-log.js';
import { AbayaDiagnostic, type Step } from '../../src/diagnostics/abaya-diagnostic.js';
import { MemoryOutboundRepository } from '../../src/outbound/outbound.repository.js';
import { ChatIdentityGuard } from '../../src/safety/chat-identity-guard.js';
import { MemoryKillSwitch } from '../../src/safety/kill-switch.js';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// Diagnóstico por pasos (D-020) contra el Abaya simulado con Chromium real.

const silent = createLogger('e2e', { level: 'silent' });
let mock: MockAbayaServer;

test.beforeEach(async () => {
  // Bandeja vacía (el simulador trae 2 casos de ejemplo por defecto).
  mock = new MockAbayaServer({ chats: [] });
  await mock.start();
});

test.afterEach(async () => {
  await mock.stop();
});

function diagnostic(opts: { password?: string } = {}) {
  const driver = new PlaywrightSessionDriver({
    baseUrl: mock.url,
    headless: true,
    goAvailable: false,
  });
  const actionLog = new MemoryActionLog();
  const killSwitch = new MemoryKillSwitch();
  const actor = new BrowserActor({
    robotUser: mock.username,
    page: () => driver.page,
    gate: new ActorGate(),
    killSwitch,
    guard: new ChatIdentityGuard(),
    actionLog,
    outbound: new MemoryOutboundRepository(),
    alerts: new MemoryAlertAdapter(),
    logger: silent,
  });
  const diag = new AbayaDiagnostic({
    robotUser: mock.username,
    driver,
    actor,
    killSwitch,
    actionLog,
    credentials: () => ({ username: mock.username, password: opts.password ?? mock.password }),
  });
  return { run: (s: Step) => diag.run(s), actionLog, killSwitch };
}

test('todos los pasos: Disponible ida y vuelta, sin quedar recibiendo casos', async () => {
  const t = diagnostic();
  const r = await t.run('bandeja');
  expect(r.map((x) => [x.step, x.ok])).toEqual([
    ['url', true],
    ['login', true],
    ['estado', true],
    ['disponible', true],
    ['bandeja', true],
  ]);
  expect(r[2]!.detail).toContain('«Login»');
  expect(r[3]!.detail).toContain('de vuelta a «FinTurno»');
  expect(r[4]!.detail).toBe('0 caso(s) asignado(s)');
  expect(mock.agentState).not.toBe('Disponible');
  // Login, Disponible y la vuelta a la pausa quedan en la bitácora.
  expect(t.actionLog.entries.map((e) => [e.action, e.result])).toEqual([
    ['LOGIN', 'OK'],
    ['LOGIN', 'OK'],
    ['LOGIN', 'OK'],
  ]);
});

test('el paso login no se pone Disponible', async () => {
  const r = await diagnostic().run('login');
  expect(r.every((x) => x.ok)).toBe(true);
  expect(mock.agentState).toBe('Login');
});

test('contraseña rechazada: se detiene en login y no sigue', async () => {
  const r = await diagnostic({ password: 'otra' }).run('bandeja');
  expect(r.map((x) => [x.step, x.ok])).toEqual([
    ['url', true],
    ['login', false],
  ]);
  expect(r[1]!.detail).toMatch(/^INVALID_CREDENTIALS|^TIMEOUT/);
});

test('con kill switch no inicia sesión', async () => {
  const t = diagnostic();
  t.killSwitch.active = true;
  const r = await t.run('login');
  expect(r[1]).toMatchObject({ step: 'login', ok: false });
  expect(r[1]!.detail).toContain('kill switch');
  expect(mock.loginAttempts).toBe(0);
  expect(t.actionLog.entries.at(-1)?.result).toBe('BLOCKED');
});

test('los casos que ya estaban asignados no cuentan como nuevos', async () => {
  mock.assignChat('1234567890');
  const r = await diagnostic().run('bandeja');
  expect(r.every((x) => x.ok)).toBe(true);
  expect(r[3]!.detail).not.toContain('ATENCIÓN');
  expect(r[4]!.detail).toBe('1 caso(s) asignado(s)');
});
