import { randomUUID } from 'node:crypto';
import { verifyChain } from '@abaya/crypto';
import { createLogger } from '@abaya/logger';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { BrowserActor } from '../../src/actor/browser-actor.js';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { MemoryActionLog, actionLogHashInput } from '../../src/audit/action-log.js';
import { MemoryOutboundRepository } from '../../src/outbound/outbound.repository.js';
import { ChatIdentityGuard } from '../../src/safety/chat-identity-guard.js';
import { MemoryKillSwitch } from '../../src/safety/kill-switch.js';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemorySessionRepository } from '../../src/session/session.repository.js';
import { MemoryStorageStateStore } from '../../src/session/storage-state.store.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// E2E de F4 (sección 6.4) contra el Abaya simulado.

const silent = createLogger('e2e', { level: 'silent' });

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
  const outbound = new MemoryOutboundRepository();
  const actionLog = new MemoryActionLog();
  const alerts = new MemoryAlertAdapter();
  const killSwitch = new MemoryKillSwitch();
  const actor = new BrowserActor({
    robotUser: mock.username,
    page: () => driver.page,
    gate,
    killSwitch,
    guard: new ChatIdentityGuard(),
    actionLog,
    outbound,
    alerts,
    logger: silent,
    verifyTimeoutMs: 2_000,
  });
  let n = 0;
  const queue = (abayaChatId: string, text: string) => {
    const id = `out-${++n}`;
    const idempotencyKey = randomUUID();
    outbound.messages.set(id, {
      id,
      abayaChatId,
      idempotencyKey,
      text,
      status: 'PENDING',
      attempts: 0,
    });
    return id;
  };
  return { mgr, actor, outbound, actionLog, alerts, killSwitch, queue, gate };
}

let mock: MockAbayaServer;
test.beforeEach(async () => {
  mock = new MockAbayaServer();
  for (const c of ['CH-2001', 'CH-2002', 'CH-2003']) mock.assignChat(c);
  await mock.start();
});
test.afterEach(async () => {
  await mock.stop();
});

test('100 envíos: 100 verificados, 0 en chat equivocado, 0 duplicados', async () => {
  test.setTimeout(180_000);
  const t = await boot(mock);
  const chats = ['CH-1001', 'CH-1002', 'CH-2001', 'CH-2002', 'CH-2003'];
  const expected: { id: string; chatId: string; text: string }[] = [];
  for (let i = 0; i < 100; i++) {
    const chatId = chats[i % chats.length]!;
    const text = i % 7 === 0 ? `*Mensaje ${i}*\nCon salto de línea` : `Mensaje sintético ${i}`;
    expected.push({ id: t.queue(chatId, text), chatId, text });
  }
  // Se encolan todos a la vez: el actor los serializa.
  const results = await Promise.all(expected.map((e) => t.actor.sendMessage(e.id)));

  expect(results.filter((r) => r === 'SENT_VERIFIED')).toHaveLength(100);
  expect(mock.agentPosts).toHaveLength(100);
  for (const e of expected) {
    const posts = mock.agentPosts.filter((p) => p.text === e.text);
    expect(posts).toHaveLength(1); // 0 duplicados
    expect(posts[0]!.chatId).toBe(e.chatId); // 0 en chat equivocado
  }
  // Auditoría con cadena de hashes íntegra.
  const chain = t.actionLog.entries.map((e) => ({
    data: actionLogHashInput(e),
    prevHash: e.prevHash,
    hash: e.hash,
  }));
  expect(verifyChain(chain)).toBe(-1);
  await t.mgr.stop();
});

test('con KillSwitch activo no se envía nada', async () => {
  const t = await boot(mock);
  t.killSwitch.active = true;
  const id = t.queue('CH-1001', 'No debería salir');
  expect(await t.actor.sendMessage(id)).toBe('BLOCKED_KILL_SWITCH');
  expect(mock.agentPosts).toHaveLength(0);
  expect((await t.outbound.get(id))?.status).toBe('PENDING');
  expect(t.actionLog.entries.at(-1)?.result).toBe('BLOCKED');
  await t.mgr.stop();
});

test('falla de verificación: queda UNCERTAIN, alerta y no se reintenta', async () => {
  const t = await boot(mock);
  mock.dropOutgoing = true;
  const id = t.queue('CH-1001', 'Este no se verá');
  expect(await t.actor.sendMessage(id)).toBe('UNCERTAIN');
  expect((await t.outbound.get(id))?.status).toBe('UNCERTAIN');
  expect(t.alerts.raised).toEqual([
    expect.objectContaining({ code: 'SEND_UNCERTAIN', severity: 'ALTA' }),
  ]);

  // Un segundo intento (p. ej. reintento de la cola) NO vuelve a escribir.
  mock.dropOutgoing = false;
  const postsBefore = mock.agentPosts.length;
  expect(await t.actor.sendMessage(id)).toBe('SKIPPED_UNCERTAIN');
  expect(mock.agentPosts.length).toBe(postsBefore);
  await t.mgr.stop();
});

test('ChatIdentityGuard: si se abre otro chat, aborta sin escribir y alerta', async () => {
  const t = await boot(mock);
  mock.misroute.set('CH-2001', 'CH-2002');
  const id = t.queue('CH-2001', 'Dato para CH-2001');
  expect(await t.actor.sendMessage(id)).toBe('UNCERTAIN');
  expect(mock.agentPosts).toHaveLength(0);
  expect(t.alerts.raised[0]).toMatchObject({ code: 'SEND_UNCERTAIN' });
  await t.mgr.stop();
});

test('idempotencia: proceso muerto en SENDING con el texto ya en pantalla → no se reenvía', async () => {
  const t = await boot(mock);
  // El fixture CH-1001 ya tiene "¡Hola! Con gusto te ayudo." del asesor.
  const id = t.queue('CH-1001', '¡Hola! Con gusto te ayudo.');
  await t.outbound.setStatus(id, 'SENDING', true);
  expect(await t.actor.sendMessage(id)).toBe('ALREADY_SENT');
  expect(mock.agentPosts).toHaveLength(0);
  expect((await t.outbound.get(id))?.status).toBe('SENT_VERIFIED');
  await t.mgr.stop();
});

test('regresión: una respuesta nueva con el mismo texto que una anterior SÍ se envía', async () => {
  const t = await boot(mock);
  // El robot ya dijo esto antes, pero este mensaje (PENDING) es una respuesta nueva.
  const id = t.queue('CH-1001', '¡Hola! Con gusto te ayudo.');
  expect(await t.actor.sendMessage(id)).toBe('SENT_VERIFIED');
  expect(mock.agentPosts).toEqual([{ chatId: 'CH-1001', text: '¡Hola! Con gusto te ayudo.' }]);
  // Y dos respuestas idénticas seguidas también salen las dos.
  const id2 = t.queue('CH-1001', '¡Hola! Con gusto te ayudo.');
  expect(await t.actor.sendMessage(id2)).toBe('SENT_VERIFIED');
  expect(mock.agentPosts).toHaveLength(2);
  await t.mgr.stop();
});

test('regresión: un texto repetido que no llega queda UNCERTAIN (no se confunde con el anterior)', async () => {
  const t = await boot(mock);
  mock.dropOutgoing = true;
  // "¡Hola! Con gusto te ayudo." ya existe confirmado en CH-1001: no debe contar como entrega.
  const id = t.queue('CH-1001', '¡Hola! Con gusto te ayudo.');
  expect(await t.actor.sendMessage(id)).toBe('UNCERTAIN');
  await t.mgr.stop();
});

test('proceso muerto en SENDING y texto ausente: UNCERTAIN, sin reenviar', async () => {
  const t = await boot(mock);
  const id = t.queue('CH-1002', 'Envío interrumpido');
  await t.outbound.setStatus(id, 'SENDING', true);
  expect(await t.actor.sendMessage(id)).toBe('UNCERTAIN');
  expect(mock.agentPosts).toHaveLength(0);
  await t.mgr.stop();
});

test('la compuerta de sesión cerrada detiene las acciones hasta que se abre', async () => {
  const t = await boot(mock);
  t.gate.pause('session');
  const id = t.queue('CH-1001', 'Espera a la sesión');
  const p = t.actor.sendMessage(id);
  await new Promise((r) => setTimeout(r, 500));
  expect(mock.agentPosts).toHaveLength(0);
  t.gate.resume('session');
  expect(await p).toBe('SENT_VERIFIED');
  await t.mgr.stop();
});
