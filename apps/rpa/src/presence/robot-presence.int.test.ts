import { MemoryAlertAdapter } from '@abaya/alerts';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { createLogger } from '@abaya/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RobotRefusedError } from '../lifecycle.js';
import {
  PRESENCE_STALE_MS,
  PrismaPresenceStore,
  RobotPresence,
  type InstanceInfo,
} from './robot-presence.js';

// Un robot = un equipo a la vez (v1.4), contra PostgreSQL real (temporal).

let db: TestDatabase;
let store: PrismaPresenceStore;
const logger = createLogger('t', { level: 'silent' });

beforeAll(async () => {
  db = await startTestDatabase();
  store = new PrismaPresenceStore(db.prisma);
}, 120_000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const pc = (n: number): InstanceInfo => ({
  robotUser: 'robot-ventas-01',
  instanceId: `instancia-${n}`,
  host: `PC-0${n}`,
  version: '1.0.0',
});

function presence(info: InstanceInfo, now: () => Date = () => new Date()) {
  const alerts = new MemoryAlertAdapter();
  const evicted: string[] = [];
  const p = new RobotPresence({
    store,
    info,
    alerts,
    logger,
    now,
    everyMs: 3_600_000, // los latidos se llaman a mano en las pruebas
    onEvicted: (r) => evicted.push(r),
  });
  return { p, alerts, evicted };
}

describe('presencia del robot', () => {
  it('registra el equipo, la versión y el inicio; al apagarse en orden queda STOPPED', async () => {
    const a = presence(pc(1));
    await a.p.start();
    expect(
      await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-ventas-01' } }),
    ).toMatchObject({
      state: 'ONLINE',
      host: 'PC-01',
      version: '1.0.0',
      instanceId: 'instancia-1',
    });
    await a.p.stop();
    expect(
      await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-ventas-01' } }),
    ).toMatchObject({ state: 'STOPPED', instanceId: null });
  });

  it('el mismo usuario en un segundo equipo se rechaza, se alerta y queda registrado', async () => {
    await presence(pc(1)).p.start();
    const b = presence(pc(2));
    await expect(b.p.start()).rejects.toBeInstanceOf(RobotRefusedError);
    await expect(b.p.start()).rejects.toThrow(/PC-01/);
    expect(b.alerts.raised.map((r) => r.code)).toContain('ROBOT_DUPLICATE');
    expect(
      await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-ventas-01' } }),
    ).toMatchObject({ host: 'PC-01', lastRejectedHost: 'PC-02' });
  });

  it('dos equipos arrancando a la vez: solo uno gana', async () => {
    const results = await Promise.allSettled([1, 2, 3].map((n) => presence(pc(n)).p.start()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('si el equipo en línea se cae (sin presencia > 60 s), otro puede tomar el robot', async () => {
    const t0 = Date.now();
    await presence(pc(1), () => new Date(t0)).p.start();
    const later = () => new Date(t0 + PRESENCE_STALE_MS + 1_000);
    const b = presence(pc(2), later);
    await b.p.start();
    expect(
      await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-ventas-01' } }),
    ).toMatchObject({ host: 'PC-02', state: 'ONLINE' });
  });

  it('deshabilitado desde el panel: no arranca, y el que está en marcha se apaga', async () => {
    const a = presence(pc(1));
    await a.p.start();
    expect(await a.p.beat()).toBe('OK');
    await db.prisma.robot.update({
      where: { robotUser: 'robot-ventas-01' },
      data: { enabled: false },
    });
    expect(await a.p.beat()).toBe('DISABLED');
    expect(a.evicted).toEqual(['DISABLED']);
    await a.p.stop();
    expect(
      await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-ventas-01' } }),
    ).toMatchObject({ state: 'STOPPED', instanceId: null });
    await expect(presence(pc(2)).p.start()).rejects.toThrow(/deshabilitado/);
  });

  it('si otra instancia tomó el robot, la anterior lo detecta en su presencia y se apaga', async () => {
    const t0 = Date.now();
    const a = presence(pc(1), () => new Date(t0));
    await a.p.start();
    await presence(pc(2), () => new Date(t0 + PRESENCE_STALE_MS + 1_000)).p.start();
    expect(await a.p.beat()).toBe('LOST');
    expect(a.evicted).toEqual(['LOST']);
    // Liberar al apagarse no le quita el robot al equipo que lo tiene ahora.
    await a.p.stop();
    expect(
      await db.prisma.robot.findUniqueOrThrow({ where: { robotUser: 'robot-ventas-01' } }),
    ).toMatchObject({ host: 'PC-02', state: 'ONLINE' });
  });
});
