import { MemoryAlertAdapter } from '@abaya/alerts';
import { describe, expect, it } from 'vitest';
import { runSmokeTest } from './smoke-test.js';

const base = (over: Partial<Parameters<typeof runSmokeTest>[0]> = {}) => {
  const alerts = new MemoryAlertAdapter();
  return {
    alerts,
    deps: {
      sessionStatus: () => 'ACTIVE',
      readInbox: async () => ['CH-1', 'CH-2'],
      alerts,
      robotUser: 'robot-01',
      ...over,
    },
  };
};

describe('runSmokeTest', () => {
  it('sesión activa y bandeja legible: ok, sin alertas', async () => {
    const t = base();
    expect(await runSmokeTest(t.deps)).toEqual({ ok: true, chats: 2 });
    expect(t.alerts.raised).toEqual([]);
  });

  it('sesión caída: falla y alerta', async () => {
    const t = base({ sessionStatus: () => 'DOWN' });
    expect(await runSmokeTest(t.deps)).toMatchObject({ ok: false });
    expect(t.alerts.raised[0]).toMatchObject({ code: 'SMOKE_TEST_FAILED', severity: 'ALTA' });
  });

  it('bandeja que no responde: timeout y alerta', async () => {
    const t = base({ readInbox: () => new Promise(() => undefined), timeoutMs: 20 });
    expect(await runSmokeTest(t.deps)).toEqual({
      ok: false,
      reason: 'bandeja no legible: timeout',
    });
  });
});
