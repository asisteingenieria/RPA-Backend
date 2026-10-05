import { Writable } from 'node:stream';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import type { LoginCredentials, LoginResult } from '../abaya/pages/login.page.js';
import { ActorGate } from '../actor/actor-gate.js';
import { MemoryAlertAdapter } from '../alerts/log-alert.adapter.js';
import type { SessionDriver } from './session-driver.js';
import { SessionManager } from './session-manager.js';
import { MemorySessionRepository } from './session.repository.js';
import { MemoryStorageStateStore, type StorageState } from './storage-state.store.js';

const SECRET = 'clave-super-secreta';
const STATE: StorageState = { cookies: [], origins: [] };

class FakeDriver implements SessionDriver {
  loggedIn = false;
  opens: (StorageState | undefined)[] = [];
  loginResults: LoginResult[] = [];
  loginCalls = 0;
  /** Si es true, abrir con storageState restaura la sesión. */
  stateValid = true;

  async open(state?: StorageState) {
    this.opens.push(state);
    if (state && this.stateValid) this.loggedIn = true;
    else if (!state) this.loggedIn = false;
  }
  async isInboxVisible() {
    return this.loggedIn;
  }
  async login(_creds: LoginCredentials): Promise<LoginResult> {
    this.loginCalls++;
    const r = this.loginResults.shift() ?? 'OK';
    this.loggedIn = r === 'OK';
    return r;
  }
  async exportState() {
    return STATE;
  }
  async close() {}
}

function setup(over: Partial<{ driver: FakeDriver; store: MemoryStorageStateStore }> = {}) {
  const driver = over.driver ?? new FakeDriver();
  const store = over.store ?? new MemoryStorageStateStore();
  const repo = new MemorySessionRepository();
  const alerts = new MemoryAlertAdapter();
  const gate = new ActorGate();
  const sleeps: number[] = [];
  const logs: string[] = [];
  const logger = createLogger(
    'test',
    { level: 'debug' },
    new Writable({
      write(c, _e, cb) {
        logs.push(c.toString());
        cb();
      },
    }),
  );
  let recovered = 0;
  const mgr = new SessionManager({
    robotUser: 'robot-ventas-01',
    driver,
    store,
    repo,
    alerts,
    gate,
    logger,
    credentials: () => ({ username: 'robot-ventas-01', password: SECRET }),
    heartbeatMs: 60_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onRecovered: async () => {
      recovered++;
    },
  });
  return { mgr, driver, store, repo, alerts, gate, sleeps, logs, recovered: () => recovered };
}

describe('SessionManager', () => {
  it('restaura la sesión desde storageState sin hacer login', async () => {
    const store = new MemoryStorageStateStore();
    store.state = STATE;
    const t = setup({ store });
    expect(await t.mgr.start()).toBe('ACTIVE');
    expect(t.driver.loginCalls).toBe(0);
    expect(t.gate.isOpen()).toBe(true);
    await t.mgr.stop();
  });

  it('hace login si no hay storageState y guarda el estado', async () => {
    const t = setup();
    expect(await t.mgr.start()).toBe('ACTIVE');
    expect(t.driver.loginCalls).toBe(1);
    expect(t.store.state).toEqual(STATE);
    expect(t.sleeps).toEqual([]); // primer login sin espera
    expect((await t.repo.get('robot-ventas-01'))?.lastLoginAt).toBeInstanceOf(Date);
    await t.mgr.stop();
  });

  it('hace login si el storageState ya no es válido', async () => {
    const store = new MemoryStorageStateStore();
    store.state = STATE;
    const driver = new FakeDriver();
    driver.stateValid = false;
    const t = setup({ store, driver });
    expect(await t.mgr.start()).toBe('ACTIVE');
    expect(driver.loginCalls).toBe(1);
    await t.mgr.stop();
  });

  it('heartbeat con sesión viva actualiza lastHeartbeat sin relogin', async () => {
    const t = setup();
    await t.mgr.start();
    await t.mgr.heartbeat();
    expect(t.driver.loginCalls).toBe(1);
    expect(t.mgr.status).toBe('ACTIVE');
    await t.mgr.stop();
  });

  it('si la sesión cae: pausa el actor, relogin con espera de 5 s, reanuda y reconcilia', async () => {
    const t = setup();
    await t.mgr.start();
    t.driver.loggedIn = false; // sesión cerrada a mano

    let gateDuringLogin: boolean | undefined;
    const origLogin = t.driver.login.bind(t.driver);
    t.driver.login = async (c) => {
      gateDuringLogin = t.gate.isOpen();
      return origLogin(c);
    };

    await t.mgr.heartbeat();
    expect(gateDuringLogin).toBe(false);
    expect(t.sleeps).toEqual([5_000]);
    expect(t.mgr.status).toBe('ACTIVE');
    expect(t.gate.isOpen()).toBe(true);
    expect(t.recovered()).toBe(1);
    await t.mgr.stop();
  });

  it('con contraseña incorrecta se detiene tras 3 intentos, queda DOWN y alerta', async () => {
    const driver = new FakeDriver();
    driver.loginResults = [
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'OK',
    ];
    const t = setup({ driver });
    expect(await t.mgr.start()).toBe('DOWN');
    expect(driver.loginCalls).toBe(3);
    expect(t.sleeps).toEqual([5_000, 15_000]);
    expect(t.gate.isOpen()).toBe(false);
    expect(t.alerts.raised).toEqual([
      expect.objectContaining({ code: 'SESSION_DOWN', severity: 'CRITICA' }),
    ]);
    expect((await t.repo.get('robot-ventas-01'))?.status).toBe('DOWN');
  });

  it('esperas progresivas 5 s, 15 s, 45 s cuando cae la sesión y no logra entrar', async () => {
    const t = setup();
    await t.mgr.start();
    t.driver.loggedIn = false;
    t.driver.loginResults = ['TIMEOUT', 'TIMEOUT', 'TIMEOUT'];
    await t.mgr.heartbeat();
    expect(t.sleeps).toEqual([5_000, 15_000, 45_000]);
    expect(t.mgr.status).toBe('DOWN');
    expect(t.recovered()).toBe(0);
  });

  it('se recupera si un reintento funciona antes del tercer fallo', async () => {
    const driver = new FakeDriver();
    driver.loginResults = ['TIMEOUT', 'OK'];
    const t = setup({ driver });
    expect(await t.mgr.start()).toBe('ACTIVE');
    expect(t.mgr.snapshot.consecutiveFails).toBe(0);
    await t.mgr.stop();
  });

  it('no arranca si la sesión quedó en DOWN (no insiste)', async () => {
    const t = setup();
    await t.repo.save({
      robotUser: 'robot-ventas-01',
      status: 'DOWN',
      lastHeartbeat: new Date(),
      lastLoginAt: null,
      consecutiveFails: 3,
    });
    expect(await t.mgr.start()).toBe('DOWN');
    expect(t.driver.loginCalls).toBe(0);
    expect(t.driver.opens).toEqual([]);
    expect(t.alerts.raised[0]?.code).toBe('SESSION_DOWN');
  });

  it('nunca escribe la contraseña en logs ni alertas', async () => {
    const driver = new FakeDriver();
    driver.loginResults = ['INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS'];
    const t = setup({ driver });
    await t.mgr.start();
    expect(t.logs.join('')).not.toContain(SECRET);
    expect(JSON.stringify(t.alerts.raised)).not.toContain(SECRET);
  });
});
