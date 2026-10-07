import { randomBytes } from 'node:crypto';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { FieldCipher } from '@abaya/crypto';
import { inboundAad } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { BrowserActor } from '../../src/actor/browser-actor.js';
import { MemoryActionLog } from '../../src/audit/action-log.js';
import { InboundProcessor } from '../../src/inbound/inbound-processor.js';
import { MemoryInboundQueue } from '../../src/inbound/inbound-queue.js';
import { InboundWatcher } from '../../src/inbound/inbound-watcher.js';
import { MemoryInboundRepository } from '../../src/inbound/inbound.repository.js';
import { MissedMessageSweeper } from '../../src/inbound/missed-sweeper.js';
import { MemoryOutboundRepository } from '../../src/outbound/outbound.repository.js';
import { ChatIdentityGuard } from '../../src/safety/chat-identity-guard.js';
import { MemoryKillSwitch } from '../../src/safety/kill-switch.js';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemorySessionRepository } from '../../src/session/session.repository.js';
import { MemoryStorageStateStore } from '../../src/session/storage-state.store.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// v1.5: un mensaje que el WebSocket no entregó (corte, recarga) se recupera con el barrido.
// Encontrado por la prueba de carga: abrir un chat recarga la página y, en ese instante, un
// mensaje de OTRO chat no llegaba por ningún lado.

const cipher = new FieldCipher(randomBytes(32).toString('base64'));
const silent = createLogger('e2e', { level: 'silent' });

let mock: MockAbayaServer;
test.beforeEach(async () => {
  mock = new MockAbayaServer({ chats: [] });
  for (const c of ['CH-3001', 'CH-3002', 'CH-3003']) mock.assignChat(c);
  await mock.start();
});
test.afterEach(async () => {
  await mock.stop();
});

test('mensaje no avisado por WebSocket: la bandeja lo marca y el barrido lo recupera sin duplicados', async () => {
  const repo = new MemoryInboundRepository();
  const processor = new InboundProcessor({
    robotUser: mock.username,
    repo,
    queue: new MemoryInboundQueue(),
    cipher,
    logger: silent,
  });
  const watcher = new InboundWatcher(processor, silent);
  const driver = new PlaywrightSessionDriver({ baseUrl: mock.url, headless: true });
  driver.onPage = (page) => watcher.attach(page);
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
    heartbeatMs: 60_000,
  });
  expect(await mgr.start()).toBe('ACTIVE');
  const actor = new BrowserActor({
    robotUser: mock.username,
    page: () => driver.page,
    gate,
    killSwitch: new MemoryKillSwitch(),
    guard: new ChatIdentityGuard(),
    actionLog: new MemoryActionLog(),
    outbound: new MemoryOutboundRepository(),
    alerts: new MemoryAlertAdapter(),
    logger: silent,
  });
  const sweeper = new MissedMessageSweeper({
    robotUser: mock.username,
    actor,
    // Nada en curso en el sistema para ningún chat.
    repo: { idleChats: async (_r, ids) => ids },
    logger: silent,
  });

  // 1. Normal: llega por WebSocket.
  mock.addCustomerMessage('CH-3001', 'hola, quiero un plan');
  await expect.poll(() => processor.stats.stored, { timeout: 5_000 }).toBe(1);

  // 2. Corte: el mensaje existe en Abaya pero el navegador no recibe el aviso.
  mock.addCustomerMessage('CH-3002', 'este se pierde', { broadcast: false });
  await driver.page.waitForTimeout(1_500);
  expect(processor.stats.stored).toBe(1);

  // 3. El robot abre otro chat (recarga): la bandeja ahora muestra el no leído de CH-3002.
  expect(await actor.openChat('CH-3003')).toBe(true);
  expect((await actor.readInbox()).find((c) => c.abayaChatId === 'CH-3002')?.unread).toBe(1);

  // 4. El barrido lo detecta y lo recupera.
  const opened = await sweeper.sweep();
  expect(opened).toContain('CH-3002');
  await expect.poll(() => processor.stats.stored, { timeout: 5_000 }).toBe(2);
  const texts = [...repo.messages.values()].map((m) =>
    cipher.decryptString(m.bodyEncrypted, inboundAad(m.fingerprint)),
  );
  expect(texts.sort()).toEqual(['este se pierde', 'hola, quiero un plan']);

  // 5. Ya al día: un segundo barrido no abre nada y no hay duplicados.
  await processor.drain();
  expect(await sweeper.sweep()).toEqual([]);
  expect(processor.stats.stored).toBe(2);

  await mgr.stop();
});
