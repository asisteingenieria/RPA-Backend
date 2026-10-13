import { randomUUID } from 'node:crypto';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { createLogger } from '@abaya/logger';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { BrowserActor } from '../../src/actor/browser-actor.js';
import { MemoryActionLog } from '../../src/audit/action-log.js';
import { MemoryOutboundRepository } from '../../src/outbound/outbound.repository.js';
import { ChatIdentityGuard } from '../../src/safety/chat-identity-guard.js';
import { MemoryKillSwitch } from '../../src/safety/kill-switch.js';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemorySessionRepository } from '../../src/session/session.repository.js';
import { MemoryStorageStateStore } from '../../src/session/storage-state.store.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

// D-014 fase 2: la imagen de planes se pega en la caja, como la asesora, y sale con su pie de
// foto en un solo mensaje. Contra el Abaya simulado (ySocial).

const silent = createLogger('e2e', { level: 'silent' });
/** PNG de 1×1 (sintético). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let mock: MockAbayaServer;
test.beforeEach(async () => {
  mock = new MockAbayaServer();
  for (const c of ['3001', '3002']) mock.assignChat(c);
  await mock.start();
});
test.afterEach(async () => {
  await mock.stop();
});

async function boot() {
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
  const alerts = new MemoryAlertAdapter();
  const actor = new BrowserActor({
    robotUser: mock.username,
    page: () => driver.page,
    gate,
    killSwitch: new MemoryKillSwitch(),
    guard: new ChatIdentityGuard(),
    actionLog: new MemoryActionLog(),
    outbound,
    alerts,
    logger: silent,
    verifyTimeoutMs: 3_000,
  });
  let n = 0;
  const queue = (abayaChatId: string, text: string, image: Buffer | null = PNG) => {
    const id = `img-${++n}`;
    outbound.messages.set(id, {
      id,
      abayaChatId,
      idempotencyKey: randomUUID(),
      text,
      status: 'PENDING',
      attempts: 0,
      image: { id: `vi-${n}`, mime: 'image/png', fileName: 'migracion-1.png' },
    });
    if (image) outbound.images.set(id, new Uint8Array(image));
    return id;
  };
  return { mgr, actor, outbound, alerts, queue, driver };
}

test('pega la imagen y sale con su pie de foto en un solo mensaje, en el caso correcto', async () => {
  const { mgr, actor, outbound, queue } = await boot();
  try {
    const id = queue('3002', 'Por el proceso de cambio de operador te puedo otorgar esta opción:');
    expect(await actor.sendMessage(id)).toBe('SENT_VERIFIED');
    expect(outbound.messages.get(id)!.status).toBe('SENT_VERIFIED');
    expect(mock.agentPosts).toEqual([
      {
        chatId: '3002',
        text: 'Por el proceso de cambio de operador te puedo otorgar esta opción:',
        attachments: [
          { mime: 'image/png', fileName: 'migracion-1.png', size: PNG.length, bytes: PNG.length },
        ],
      },
    ]);

    // Las demás imágenes van sin texto: también se verifican (fila con adjunto y cuerpo vacío).
    const rest = queue('3002', '');
    expect(await actor.sendMessage(rest)).toBe('SENT_VERIFIED');
    expect(mock.agentPosts.at(-1)?.attachments).toHaveLength(1);
    expect(mock.chat('3002')!.messages.filter((m) => m.attachment)).toHaveLength(2);
  } finally {
    await mgr.stop();
  }
});

test('sin bytes de la imagen no toca Abaya: FAILED con alerta', async () => {
  const { mgr, actor, outbound, alerts, queue } = await boot();
  try {
    const id = queue('3001', 'Mira esta opción', null);
    expect(await actor.sendMessage(id)).toBe('FAILED');
    expect(outbound.messages.get(id)!.status).toBe('FAILED');
    expect(mock.agentPosts).toEqual([]);
    expect(alerts.raised.map((a) => a.code)).toContain('SEND_IMAGE_MISSING');
  } finally {
    await mgr.stop();
  }
});

test('si la imagen no aparece tras enviar queda UNCERTAIN y no se reintenta (regla 2)', async () => {
  const { mgr, actor, outbound, queue } = await boot();
  try {
    mock.dropOutgoing = true;
    const id = queue('3001', 'Mira esta opción');
    expect(await actor.sendMessage(id)).toBe('UNCERTAIN');
    mock.dropOutgoing = false;
    expect(await actor.sendMessage(id)).toBe('SKIPPED_UNCERTAIN');
    expect(mock.agentPosts).toHaveLength(1);
    expect(outbound.messages.get(id)!.status).toBe('UNCERTAIN');
  } finally {
    await mgr.stop();
  }
});

test('un envío de imagen interrumpido (SENDING) no se repite a ciegas', async () => {
  const { mgr, actor, outbound, queue } = await boot();
  try {
    const id = queue('3001', 'Mira esta opción');
    outbound.messages.get(id)!.status = 'SENDING';
    expect(await actor.sendMessage(id)).toBe('UNCERTAIN');
    expect(mock.agentPosts).toEqual([]);
  } finally {
    await mgr.stop();
  }
});
