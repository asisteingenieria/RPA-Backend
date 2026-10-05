import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { FieldCipher } from '@abaya/crypto';
import { outboundAad } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { expect, test } from '@playwright/test';
import { ActorGate } from '../../src/actor/actor-gate.js';
import { BrowserActor } from '../../src/actor/browser-actor.js';
import { MemoryActionLog } from '../../src/audit/action-log.js';
import {
  PlaywrightTraceRecorder,
  cleanupTraces,
  decryptTrace,
} from '../../src/observability/trace-recorder.js';
import { MemoryOutboundRepository } from '../../src/outbound/outbound.repository.js';
import { ChatIdentityGuard } from '../../src/safety/chat-identity-guard.js';
import { MemoryKillSwitch } from '../../src/safety/kill-switch.js';
import { PlaywrightSessionDriver } from '../../src/session/playwright-session-driver.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemorySessionRepository } from '../../src/session/session.repository.js';
import { MemoryStorageStateStore } from '../../src/session/storage-state.store.js';
import { MockAbayaServer } from '../mock-abaya/mock-server.js';

const silent = createLogger('e2e', { level: 'silent' });
const cipher = new FieldCipher(randomBytes(32).toString('base64'));

test('trazas solo en error: cifradas, referenciadas en la auditoría; los éxitos no dejan traza', async () => {
  const mock = new MockAbayaServer();
  await mock.start();
  const traceDir = await mkdtemp(join(tmpdir(), 'abaya-traces-'));
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
  const actor = new BrowserActor({
    robotUser: mock.username,
    page: () => driver.page,
    gate,
    killSwitch: new MemoryKillSwitch(),
    guard: new ChatIdentityGuard(),
    actionLog,
    outbound,
    cipher,
    alerts: new MemoryAlertAdapter(),
    logger: silent,
    verifyTimeoutMs: 1_500,
    tracer: new PlaywrightTraceRecorder(() => driver.currentContext, traceDir, cipher),
  });
  const queue = (text: string) => {
    const id = randomUUID();
    const key = randomUUID();
    outbound.messages.set(id, {
      id,
      abayaChatId: 'CH-1001',
      idempotencyKey: key,
      bodyEncrypted: cipher.encrypt(text, outboundAad(key)),
      status: 'PENDING',
      attempts: 0,
    });
    return id;
  };

  expect(await actor.sendMessage(queue('Envío correcto'))).toBe('SENT_VERIFIED');
  expect(await readdir(traceDir)).toEqual([]);

  mock.dropOutgoing = true;
  expect(await actor.sendMessage(queue('Envío que no se verá'))).toBe('UNCERTAIN');
  const files = await readdir(traceDir);
  expect(files).toHaveLength(1);
  const ref = files[0]!.replace('.trace.enc', '');
  expect(actionLog.entries.at(-1)).toMatchObject({ result: 'UNCERTAIN', traceRef: ref });

  // Descifrada es un zip de Playwright válido; cifrada no lo es.
  const out = join(traceDir, 'trace.zip');
  await decryptTrace(traceDir, ref, cipher, out);
  const { readFile } = await import('node:fs/promises');
  expect((await readFile(out)).subarray(0, 2).toString()).toBe('PK');
  expect((await readFile(join(traceDir, files[0]!))).subarray(0, 2).toString()).not.toBe('PK');

  await mgr.stop();
  await mock.stop();
});

test('limpieza: borra trazas de más de 7 días y conserva las recientes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abaya-traces-'));
  await writeFile(join(dir, 'vieja.trace.enc'), 'x');
  await writeFile(join(dir, 'nueva.trace.enc'), 'x');
  await writeFile(join(dir, 'otro-archivo.txt'), 'x');
  const old = new Date(Date.now() - 8 * 86_400_000);
  await utimes(join(dir, 'vieja.trace.enc'), old, old);
  expect(await cleanupTraces(dir, 7)).toBe(1);
  expect((await readdir(dir)).sort()).toEqual(['nueva.trace.enc', 'otro-archivo.txt']);
});
