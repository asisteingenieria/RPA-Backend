import { describe, expect, it } from 'vitest';
import { CompositeAlertAdapter, MemoryAlertAdapter, WebhookAlertAdapter } from './index.js';
import { createLogger } from '@abaya/logger';

describe('WebhookAlertAdapter', () => {
  it('envía texto con severidad, código e identificadores', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    await new WebhookAlertAdapter('https://hooks.test/x', {
      environment: 'pruebas',
      fetchFn,
    }).raise('SESSION_DOWN', 'CRITICA', {
      robotUser: 'robot-01',
      conversationIds: ['c1', 'c2'],
      profile: { name: 'Ana' },
    });
    const text = JSON.parse(calls[0]!.body).text as string;
    expect(text).toContain('CRITICA');
    expect(text).toContain('[pruebas]');
    expect(text).toContain('robotUser: robot-01');
    expect(text).toContain('c1, c2');
    expect(text).not.toContain('Ana'); // objetos anidados (posibles datos personales) no se envían
  });

  it('falla si el webhook responde error', async () => {
    const fetchFn = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await expect(
      new WebhookAlertAdapter('https://h', { fetchFn }).raise('X', 'ALTA'),
    ).rejects.toThrow(/500/);
  });
});

describe('CompositeAlertAdapter', () => {
  it('un canal caído no impide los demás', async () => {
    const ok = new MemoryAlertAdapter();
    const broken = { raise: async () => Promise.reject(new Error('caído')) };
    await new CompositeAlertAdapter([broken, ok], createLogger('t', { level: 'silent' })).raise(
      'X',
      'ALTA',
    );
    expect(ok.raised).toHaveLength(1);
  });
});
