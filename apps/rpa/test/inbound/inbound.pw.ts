import { randomBytes } from 'node:crypto';
import { FieldCipher } from '@abaya/crypto';
import type { InboundMessage } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { InboundProcessor } from '../../src/inbound/inbound-processor.js';
import { MemoryInboundQueue } from '../../src/inbound/inbound-queue.js';
import { InboundWatcher } from '../../src/inbound/inbound-watcher.js';
import { MemoryInboundRepository } from '../../src/inbound/inbound.repository.js';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemorySessionRepository } from '../../src/session/session.repository.js';
import { MemoryStorageStateStore } from '../../src/session/storage-state.store.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// E2E de F3 contra el Abaya simulado (WebSocket + polling + DOM).

const cipher = new FieldCipher(randomBytes(32).toString('base64'));
const silent = createLogger('e2e', { level: 'silent' });

async function boot(mock: MockAbayaServer, startPath = '/inbox?chat=CH-1001') {
  const repo = new MemoryInboundRepository();
  const queue = new MemoryInboundQueue();
  const storedAt = new Map<string, { at: number; via: string }>();
  const processor = new InboundProcessor({
    robotUser: mock.username,
    repo,
    queue,
    cipher,
    logger: silent,
    onStored: (m: InboundMessage, via) => storedAt.set(m.messageId!, { at: Date.now(), via }),
  });
  const watcher = new InboundWatcher(processor, silent);
  const driver = new PlaywrightSessionDriver({ baseUrl: mock.url + startPath, headless: true });
  driver.onPage = (page) => watcher.attach(page);
  const mgr = new SessionManager({
    robotUser: mock.username,
    driver,
    store: new MemoryStorageStateStore(),
    repo: new MemorySessionRepository(),
    alerts: new MemoryAlertAdapter(),
    gate: new ActorGate(),
    logger: silent,
    credentials: () => ({ username: mock.username, password: mock.password }),
    heartbeatMs: 1_000,
  });
  expect(await mgr.start()).toBe('ACTIVE');
  // Tras el login, ir al chat activo (el login redirige a /inbox).
  await driver.page.goto(mock.url + startPath);
  return { mgr, driver, processor, watcher, repo, queue, storedAt };
}

let mock: MockAbayaServer;
test.beforeEach(async () => {
  mock = new MockAbayaServer();
  await mock.start();
});
test.afterEach(async () => {
  await mock.stop();
});

test('50 mensajes en 5 chats: 0 pérdidas, 0 duplicados, detección < 3 s', async () => {
  const chats = ['CH-1001', 'CH-1002', 'CH-2001', 'CH-2002', 'CH-2003'];
  for (const c of chats.slice(2)) mock.assignChat(c);
  const t = await boot(mock);
  // El historial previo (mensajes de cliente de los fixtures) también se registra.
  await expect.poll(() => t.processor.stats.stored, { timeout: 5_000 }).toBeGreaterThan(0);
  const baseline = t.repo.messages.size;

  const sent = new Map<string, number>();
  for (let i = 0; i < 50; i++) {
    const m = mock.addCustomerMessage(chats[i % 5]!, `Mensaje sintético ${i}`);
    sent.set(m.id, Date.now());
    await new Promise((r) => setTimeout(r, 40));
  }

  await expect
    .poll(() => [...sent.keys()].filter((id) => t.storedAt.has(id)).length, { timeout: 10_000 })
    .toBe(50);
  await t.processor.drain();

  expect(t.repo.messages.size).toBe(baseline + 50);
  const latencies = [...sent].map(([id, at]) => t.storedAt.get(id)!.at - at);
  expect(Math.max(...latencies)).toBeLessThan(3_000);
  expect(t.watcher.parseFailures).toBe(0);
  await t.mgr.stop();
});

test('mensaje del chat abierto llega por red y por DOM y se guarda una sola vez', async () => {
  const t = await boot(mock);
  await expect.poll(() => t.processor.stats.stored, { timeout: 5_000 }).toBeGreaterThan(0);
  const before = t.processor.stats.received;
  const m = mock.addCustomerMessage('CH-1001', 'Quiero portar mi número');
  await expect.poll(() => t.storedAt.has(m.id), { timeout: 5_000 }).toBe(true);
  // Esperar al siguiente poll y re-render del DOM: más lecturas del mismo mensaje.
  await expect
    .poll(() => t.processor.stats.received - before, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(3);
  await t.processor.drain();
  const copies = [...t.repo.messages.values()].filter(
    (x) =>
      cipher.decryptString(x.bodyEncrypted, `msg:${x.fingerprint}`) === 'Quiero portar mi número',
  );
  expect(copies).toHaveLength(1);
  await t.mgr.stop();
});

test('mensajes propios del robot y del sistema se ignoran', async () => {
  const t = await boot(mock);
  await expect.poll(() => t.processor.stats.ignoredSystem, { timeout: 5_000 }).toBeGreaterThan(0);
  // El fixture CH-1001 tiene 1 mensaje de sistema y 1 del asesor; solo los 2 del cliente cuentan.
  await t.processor.drain();
  const texts = [...t.repo.messages.values()].map((x) =>
    cipher.decryptString(x.bodyEncrypted, `msg:${x.fingerprint}`),
  );
  expect(texts).not.toContain('Chat asignado a robot-ventas-01');
  expect(texts).not.toContain('¡Hola! Con gusto te ayudo.');
  expect(t.processor.stats.ignoredOwn).toBeGreaterThan(0);
  await t.mgr.stop();
});

test('chat nuevo asignado crea Conversation', async () => {
  const t = await boot(mock);
  mock.assignChat('CH-3001');
  await expect.poll(() => t.repo.conversations.has('CH-3001'), { timeout: 5_000 }).toBe(true);
  await t.mgr.stop();
});
