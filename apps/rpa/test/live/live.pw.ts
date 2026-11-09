import { randomUUID } from 'node:crypto';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { createLogger } from '@abaya/logger';
import type { RobotActivity, ScreenFrame } from '@abaya/robot-store';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { BrowserActor } from '../../src/actor/browser-actor.js';
import { MemoryActionLog } from '../../src/audit/action-log.js';
import { ActivityReporter } from '../../src/live/activity-reporter.js';
import { ScreenStreamer } from '../../src/live/screen-streamer.js';
import { MemoryOutboundRepository } from '../../src/outbound/outbound.repository.js';
import { ChatIdentityGuard } from '../../src/safety/chat-identity-guard.js';
import { MemoryKillSwitch } from '../../src/safety/kill-switch.js';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemorySessionRepository } from '../../src/session/session.repository.js';
import { MemoryStorageStateStore } from '../../src/session/storage-state.store.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// D-032 contra el Abaya simulado con Chromium real: la pantalla en vivo llega mientras alguien
// mira y no estorba los envíos; la actividad dice qué hace el robot y en qué chat.

const silent = createLogger('e2e', { level: 'silent' });

let mock: MockAbayaServer;
test.beforeEach(async () => {
  mock = new MockAbayaServer();
  await mock.start();
});
test.afterEach(async () => {
  await mock.stop();
});

test('pantalla en vivo y actividad mientras el robot envía', async () => {
  const driver = new PlaywrightSessionDriver({ baseUrl: mock.url, headless: true });
  const gate = new ActorGate();
  const mgr = new SessionManager({
    robotUser: mock.username,
    driver,
    store: new MemoryStorageStateStore(),
    repo: new MemorySessionRepository(),
    alerts: new MemoryAlertAdapter(),
    gate,
    logger: silent,
    credentials: () => ({ username: mock.username, password: mock.password }),
    heartbeatMs: 5_000,
  });
  expect(await mgr.start()).toBe('ACTIVE');

  const activity: RobotActivity[] = [];
  const outbound = new MemoryOutboundRepository();
  const reporter = new ActivityReporter({
    send: (a) => activity.push(a),
    queued: () => actor.queued,
    throttleMs: 0,
  });
  const actor = new BrowserActor({
    robotUser: mock.username,
    page: () => driver.page,
    gate,
    killSwitch: new MemoryKillSwitch(),
    guard: new ChatIdentityGuard(),
    actionLog: new MemoryActionLog(),
    outbound,
    alerts: new MemoryAlertAdapter(),
    logger: silent,
    verifyTimeoutMs: 2_000,
    onActivity: (a, chatId) => reporter.update(a, chatId),
  });

  const frames: ScreenFrame[] = [];
  const screen = new ScreenStreamer({
    page: () => (driver.hasPage ? driver.page : undefined),
    emit: (f) => frames.push(f),
    logger: silent,
    keyframeMs: 1_000,
  });
  screen.setWatched(true);
  await expect.poll(() => frames.length, { timeout: 10_000 }).toBeGreaterThan(0);
  // JPEG de verdad, del tamaño de la ventana del robot.
  expect(Buffer.from(frames[0]!.jpeg, 'base64').subarray(0, 3)).toEqual(
    Buffer.from([0xff, 0xd8, 0xff]),
  );
  expect(frames[0]!.width).toBeGreaterThan(100);

  const id = 'out-1';
  outbound.messages.set(id, {
    id,
    abayaChatId: '1001',
    idempotencyKey: randomUUID(),
    text: 'Mensaje sintético en vivo',
    status: 'PENDING',
    attempts: 0,
  });
  const before = frames.length;
  expect(await actor.sendMessage(id)).toBe('SENT_VERIFIED');
  expect(mock.agentPosts).toHaveLength(1);
  // Mientras escribía, la pantalla cambió y llegaron más imágenes.
  await expect.poll(() => frames.length, { timeout: 5_000 }).toBeGreaterThan(before);
  await expect
    .poll(() => activity.some((a) => a.action === 'SEND' && a.abayaChatId === '1001'))
    .toBe(true);
  await expect.poll(() => activity.at(-1)?.action).toBe('IDLE');

  // Nadie mira: no salen más imágenes.
  screen.setWatched(false);
  await new Promise((r) => setTimeout(r, 300));
  const stopped = frames.length;
  await new Promise((r) => setTimeout(r, 1_500));
  expect(frames.length).toBe(stopped);

  reporter.stop();
  await screen.stop();
  await mgr.stop();
});
