import { Writable } from 'node:stream';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import type { LoginCredentials, LoginResult } from '../abaya/pages/login.page.js';
import { ActorGate } from '../actor/actor-gate.js';
import { MemoryAlertAdapter } from '@abaya/alerts';
import type { SessionDriver } from './session-driver.js';
import { HALT_POLL_MS, SessionManager } from './session-manager.js';
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
    this.hasPage = true;
    // Un navegador nuevo solo tiene sesión si el storageState sigue siendo válido.
    this.loggedIn = !!state && this.stateValid;
  }
  async isInboxVisible() {
    return this.loggedIn;
  }
  /** D-039: lecturas forzadas de la pantalla (p. ej. 'UNKNOWN' mientras la página recarga). */
  screens: ('INBOX' | 'LOGIN' | 'UNKNOWN')[] = [];
  hasPage = false;
  reloads = 0;
  /** Si es true, recargar la página muestra la bandeja (la sesión seguía viva). */
  reloadRestores = true;
  async screen() {
    const forced = this.screens.shift();
    if (forced) return forced;
    if (!this.hasPage) return 'UNKNOWN' as const;
    return this.loggedIn ? ('INBOX' as const) : ('LOGIN' as const);
  }
  async reload() {
    this.reloads++;
    if (this.reloadRestores) this.loggedIn = true;
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
  logouts = 0;
  /** ySocial esconde «Salir» con casos asignados. */
  logoutHidden = false;
  async logout() {
    this.logouts++;
    if (this.logoutHidden) return false;
    const was = this.loggedIn;
    this.loggedIn = false;
    return was;
  }
  async close() {
    this.loggedIn = false;
    this.hasPage = false;
  }
}

/** D-040: repositorio que falla como la pasarela sin red. */
class FlakyRepo extends MemorySessionRepository {
  offline = false;
  override async save(r: Parameters<MemorySessionRepository['save']>[0]) {
    if (this.offline) throw new TypeError('fetch failed');
    return super.save(r);
  }
}

function setup(
  over: Partial<{
    driver: FakeDriver;
    store: MemoryStorageStateStore;
    halted: (sleeps: number[]) => Promise<boolean>;
    now: () => Date;
  }> = {},
) {
  const driver = over.driver ?? new FakeDriver();
  const store = over.store ?? new MemoryStorageStateStore();
  const repo = new FlakyRepo();
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
    ...(over.halted ? { halted: () => over.halted!(sleeps) } : {}),
    ...(over.now ? { now: over.now } : {}),
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

  it('D-039: lecturas sin bandeja ni login (página cargando) no tiran la sesión', async () => {
    const t = setup();
    await t.mgr.start();
    t.driver.screens = ['UNKNOWN', 'UNKNOWN'];
    await t.mgr.heartbeat();
    await t.mgr.heartbeat();
    await t.mgr.heartbeat(); // vuelve a verse la bandeja
    expect(t.driver.reloads).toBe(0);
    expect(t.driver.opens).toHaveLength(1); // nunca abrió un navegador nuevo
    expect(t.driver.loginCalls).toBe(1);
    expect(t.mgr.status).toBe('ACTIVE');
    await t.mgr.stop();
  });

  it('D-039: si no se ve nada 3 veces, recarga la MISMA página y sigue con la sesión viva', async () => {
    const t = setup();
    await t.mgr.start();
    t.driver.loggedIn = false;
    t.driver.screens = ['UNKNOWN', 'UNKNOWN', 'UNKNOWN'];
    await t.mgr.heartbeat();
    await t.mgr.heartbeat();
    await t.mgr.heartbeat();
    expect(t.driver.reloads).toBe(1);
    expect(t.driver.opens).toHaveLength(1);
    expect(t.driver.loginCalls).toBe(1);
    expect(t.mgr.status).toBe('ACTIVE');
    expect(t.gate.isOpen()).toBe(true);
    await t.mgr.stop();
  });

  it('D-039: con el login en pantalla entra en la misma página (sin navegador nuevo)', async () => {
    const t = setup();
    await t.mgr.start();
    t.driver.loggedIn = false; // Avaya cerró la sesión
    await t.mgr.heartbeat();
    expect(t.driver.opens).toHaveLength(1);
    expect(t.driver.loginCalls).toBe(2);
    expect(t.mgr.status).toBe('ACTIVE');
    await t.mgr.stop();
  });

  describe('D-040: corte de red del PC', () => {
    function clock() {
      let t = Date.parse('2026-11-10T19:40:00Z');
      return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
    }

    it('al volver la red: «Salir», recarga el login 3 veces, entra y reencola', async () => {
      const c = clock();
      const t = setup({ now: c.now });
      await t.mgr.start();
      t.repo.offline = true;
      await expect(t.mgr.heartbeat()).rejects.toThrow('fetch failed');
      c.advance(90_000);
      await expect(t.mgr.heartbeat()).rejects.toThrow('fetch failed');
      expect(t.driver.reloads).toBe(0); // sin red no se toca la página
      t.repo.offline = false;
      t.driver.reloadRestores = false; // recargar el login no entra solo
      await t.mgr.heartbeat();
      expect(t.driver.logouts).toBe(1);
      expect(t.driver.reloads).toBe(3); // solo las del login: «Salir» va antes de recargar
      expect(t.driver.loginCalls).toBe(2); // volvió a entrar
      expect(t.driver.opens).toHaveLength(1); // en la misma página, sin navegador nuevo
      expect(t.recovered()).toBe(1);
      expect(t.mgr.status).toBe('ACTIVE');
      expect(t.gate.isOpen()).toBe(true);
      expect(t.logs.join('')).toContain('volvió la red tras un corte');
      await t.mgr.heartbeat(); // ya no se repite
      expect(t.driver.logouts).toBe(1);
      await t.mgr.stop();
    });

    it('sin «Salir» visible: recarga e intenta otra vez; si sigue sin poder, alerta', async () => {
      const c = clock();
      const t = setup({ now: c.now });
      await t.mgr.start();
      t.repo.offline = true;
      await expect(t.mgr.heartbeat()).rejects.toThrow();
      c.advance(120_000);
      t.repo.offline = false;
      t.driver.logoutHidden = true;
      await t.mgr.heartbeat();
      expect(t.driver.logouts).toBe(2);
      expect(t.driver.reloads).toBe(1);
      expect(t.driver.loginCalls).toBe(1);
      expect(t.alerts.raised).toContainEqual(
        expect.objectContaining({ code: 'SESSION_STUCK', severity: 'ALTA' }),
      );
      expect(t.gate.isOpen()).toBe(true);
      await t.mgr.stop();
    });

    it('si Avaya ya muestra el login al volver la red: recarga 3 veces y entra', async () => {
      const c = clock();
      const t = setup({ now: c.now });
      await t.mgr.start();
      t.repo.offline = true;
      await expect(t.mgr.heartbeat()).rejects.toThrow();
      c.advance(120_000);
      t.repo.offline = false;
      t.driver.reloadRestores = false;
      t.driver.screens = ['INBOX']; // el heartbeat aún ve la bandeja; luego aparece el login
      t.driver.loggedIn = false;
      await t.mgr.heartbeat();
      expect(t.driver.logouts).toBe(0);
      expect(t.driver.reloads).toBe(3);
      expect(t.driver.loginCalls).toBe(2);
      expect(t.mgr.status).toBe('ACTIVE');
      await t.mgr.stop();
    });

    it('un corte corto (reinicio del servidor) no recarga la página', async () => {
      const c = clock();
      const t = setup({ now: c.now });
      await t.mgr.start();
      t.repo.offline = true;
      await expect(t.mgr.heartbeat()).rejects.toThrow();
      c.advance(20_000);
      t.repo.offline = false;
      await t.mgr.heartbeat();
      expect(t.driver.reloads).toBe(0);
      expect(t.recovered()).toBe(0);
      await t.mgr.stop();
    });
  });

  it('pausado en el panel: si el asesor hace «Salir», no vuelve a entrar hasta reanudar', async () => {
    // Pausado durante dos revisiones; a la tercera el panel ya lo reanudó.
    const polls = (sleeps: number[]) => sleeps.filter((ms) => ms === HALT_POLL_MS).length;
    let paused = false;
    const t = setup({ halted: async (sleeps) => paused && polls(sleeps) < 2 });
    await t.mgr.start();
    paused = true;
    t.driver.loggedIn = false; // el asesor terminó los chats e hizo «Salir»

    let loginsWhilePaused = 0;
    const origLogin = t.driver.login.bind(t.driver);
    t.driver.login = async (c) => {
      if (polls(t.sleeps) < 2) loginsWhilePaused++;
      return origLogin(c);
    };

    await t.mgr.heartbeat();
    expect(loginsWhilePaused).toBe(0);
    expect(t.driver.loginCalls).toBe(2); // el del arranque y el de después de reanudar
    expect(t.sleeps).toEqual([HALT_POLL_MS, HALT_POLL_MS, 5_000]);
    expect(t.mgr.status).toBe('ACTIVE');
    expect(t.recovered()).toBe(1);
    expect(t.logs.join('')).toContain('robot en pausa');
    await t.mgr.stop();
  });

  it('arranca pausado: no entra a Abaya (ni se pone Disponible) hasta reanudar', async () => {
    const t = setup({ halted: async (sleeps) => sleeps.length < 3 });
    expect(await t.mgr.start()).toBe('ACTIVE');
    expect(t.sleeps).toEqual([HALT_POLL_MS, HALT_POLL_MS, HALT_POLL_MS]);
    expect(t.driver.loginCalls).toBe(1);
    await t.mgr.stop();
  });

  it('si no se puede saber si está pausado, no entra (falla cerrado)', async () => {
    let calls = 0;
    const t = setup({
      halted: async () => {
        if (calls++ < 2) throw new Error('sin servidor');
        return false;
      },
    });
    expect(await t.mgr.start()).toBe('ACTIVE');
    expect(t.sleeps).toEqual([HALT_POLL_MS, HALT_POLL_MS]);
    expect(t.driver.loginCalls).toBe(1);
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

  it('D-038: si no logra entrar por fallos pasajeros no se rinde: espera hasta 5 min y vuelve', async () => {
    const t = setup();
    await t.mgr.start();
    t.driver.loggedIn = false;
    t.driver.loginResults = [
      'TIMEOUT',
      'ALREADY_CONNECTED',
      'TIMEOUT',
      'ALREADY_CONNECTED',
      'TIMEOUT',
      'TIMEOUT',
      'OK',
    ];
    await t.mgr.heartbeat();
    expect(t.sleeps).toEqual([5_000, 15_000, 45_000, 120_000, 300_000, 300_000, 300_000]);
    expect(t.mgr.status).toBe('ACTIVE');
    expect(t.gate.isOpen()).toBe(true);
    expect(t.recovered()).toBe(1);
    // Una sola alerta (al tercer fallo), no SESSION_DOWN.
    expect(t.alerts.raised).toEqual([
      expect.objectContaining({ code: 'SESSION_RETRYING', severity: 'ALTA' }),
    ]);
  });

  it('D-038: la alerta de reintento dice qué hacer si Avaya ve la sesión abierta', async () => {
    const driver = new FakeDriver();
    driver.loginResults = ['ALREADY_CONNECTED', 'ALREADY_CONNECTED', 'ALREADY_CONNECTED', 'OK'];
    const t = setup({ driver });
    expect(await t.mgr.start()).toBe('ACTIVE');
    expect(t.alerts.raised[0]).toMatchObject({
      code: 'SESSION_RETRYING',
      detail: expect.objectContaining({
        lastResult: 'ALREADY_CONNECTED',
        hint: expect.any(String),
      }),
    });
  });

  it('D-038: credenciales inválidas en medio de fallos pasajeros: DOWN al tercer rechazo', async () => {
    const driver = new FakeDriver();
    driver.loginResults = [
      'TIMEOUT',
      'INVALID_CREDENTIALS',
      'TIMEOUT',
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
    ];
    const t = setup({ driver });
    expect(await t.mgr.start()).toBe('DOWN');
    expect(driver.loginCalls).toBe(5);
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

  it('reciclar el navegador: «Salir», reabre sin sesión guardada y entra de nuevo', async () => {
    // ySocial real (15/10/2026): sin «Salir» el login dice «ya se encuentra conectado».
    const t = setup();
    await t.mgr.start(); // login inicial
    const logins = t.driver.loginCalls;
    t.driver.opens = [];
    expect(await t.mgr.recycle()).toBe('ACTIVE');
    expect(t.driver.logouts).toBe(1);
    expect(t.driver.opens).toEqual([undefined]);
    expect(t.driver.loginCalls).toBe(logins + 1);
    expect(t.gate.isOpen()).toBe(true);
    expect(await t.store.load()).toEqual(STATE);
  });

  it('reciclar con login fallido: relogin y la fila del robot vuelve a abrirse', async () => {
    const t = setup();
    await t.mgr.start();
    t.driver.loginResults = ['TIMEOUT', 'OK'];
    const logins = t.driver.loginCalls;
    expect(await t.mgr.recycle()).toBe('ACTIVE');
    expect(t.driver.loginCalls).toBe(logins + 2);
    expect(t.gate.isOpen()).toBe(true);
  });

  it('detener el robot hace «Salir» en Abaya antes de cerrar el navegador', async () => {
    const t = setup();
    await t.mgr.start();
    await t.mgr.stop();
    expect(t.driver.logouts).toBe(1);
  });

  it('no recicla si la sesión no está activa', async () => {
    const t = setup();
    t.driver.loginResults = ['INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS'];
    await t.mgr.start();
    t.driver.opens = [];
    expect(await t.mgr.recycle()).toBe('DOWN');
    expect(t.driver.opens).toEqual([]);
  });
});
