import { createLogger } from '@abaya/logger';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { BrowserActor } from '../../src/actor/browser-actor.js';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { MemoryActionLog } from '../../src/audit/action-log.js';
import { HandoffProcessor } from '../../src/handoff/handoff-processor.js';
import { MemoryHandoffRepository } from '../../src/handoff/handoff.repository.js';
import { MemoryOutboundRepository } from '../../src/outbound/outbound.repository.js';
import { ChatIdentityGuard } from '../../src/safety/chat-identity-guard.js';
import { MemoryKillSwitch } from '../../src/safety/kill-switch.js';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemorySessionRepository } from '../../src/session/session.repository.js';
import { MemoryStorageStateStore } from '../../src/session/storage-state.store.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// E2E de F6 (secciones 6.5 y 6.6) contra el Abaya simulado.

const silent = createLogger('e2e', { level: 'silent' });
const SUMMARY =
  '*VENTA AGENTE RPA*\nProceso: PORTABILIDAD\nPlan: P1 - Plan Porta Básico (DEMO)\nCliente: Ana';

async function boot(mock: MockAbayaServer) {
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
  const alerts = new MemoryAlertAdapter();
  const actionLog = new MemoryActionLog();
  const actor = new BrowserActor({
    robotUser: mock.username,
    page: () => driver.page,
    gate,
    killSwitch: new MemoryKillSwitch(),
    guard: new ChatIdentityGuard(),
    actionLog,
    outbound: new MemoryOutboundRepository(),
    alerts,
    logger: silent,
  });
  const repo = new MemoryHandoffRepository();
  repo.sales.set('conv-1', { summary: SUMMARY, noteOk: false });
  const processor = new HandoffProcessor({ actor, repo, alerts, logger: silent });
  return { mgr, actor, repo, alerts, processor, actionLog };
}

let mock: MockAbayaServer;
test.beforeEach(async () => {
  mock = new MockAbayaServer();
  await mock.start();
});
test.afterEach(async () => {
  await mock.stop();
});

test('venta: nota con el resumen, transferencia al backoffice y el chat sale de la bandeja', async () => {
  const t = await boot(mock);
  const decision = await t.processor.transfer(
    { conversationId: 'conv-1', abayaChatId: 'CH-1001', target: 'BACKOFFICE', afterMessageIds: [] },
    0,
  );
  expect(decision).toBe('DONE');
  expect(mock.notes).toEqual([{ chatId: 'CH-1001', note: SUMMARY }]);
  expect(mock.transfers).toEqual([{ chatId: 'CH-1001', queue: 'backoffice' }]);
  expect(mock.chat('CH-1001')).toBeUndefined();
  expect(t.repo.transferred).toEqual([{ conversationId: 'conv-1', target: 'BACKOFFICE' }]);
  expect(t.actionLog.entries.map((e) => `${e.action}:${e.result}`)).toEqual([
    'NOTE:OK',
    'TRANSFER:OK',
  ]);
  await t.mgr.stop();
});

test('transferencia fallida forzada: NEEDS_REVIEW y alerta crítica', async () => {
  const t = await boot(mock);
  mock.failTransfer = true;
  const decision = await t.processor.transfer(
    { conversationId: 'conv-1', abayaChatId: 'CH-1001', target: 'BACKOFFICE', afterMessageIds: [] },
    0,
  );
  expect(decision).toBe('NEEDS_REVIEW');
  expect(t.repo.needsReview).toEqual(['conv-1']);
  expect(t.alerts.raised).toEqual([
    expect.objectContaining({ code: 'SALE_NOT_TRANSFERRED', severity: 'CRITICA' }),
  ]);
  // La nota quedó escrita: un reintento manual no la duplica.
  expect((await t.repo.sale('conv-1'))?.noteOk).toBe(true);
  await t.mgr.stop();
});

test('escalamiento: transfiere a la cola de asesores humanos', async () => {
  const t = await boot(mock);
  expect(
    await t.processor.transfer(
      { conversationId: 'conv-2', abayaChatId: 'CH-1002', target: 'HUMAN', afterMessageIds: [] },
      0,
    ),
  ).toBe('DONE');
  expect(mock.transfers).toEqual([{ chatId: 'CH-1002', queue: 'asesores' }]);
  await t.mgr.stop();
});

test('cierre sin venta: el chat se cierra y sale de la bandeja', async () => {
  const t = await boot(mock);
  expect(
    await t.processor.close({
      conversationId: 'conv-3',
      abayaChatId: 'CH-1002',
      reason: 'SUPPORT',
      afterMessageIds: [],
    }),
  ).toBe('DONE');
  expect(mock.closed).toEqual(['CH-1002']);
  await t.mgr.stop();
});
