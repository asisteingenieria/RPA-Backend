import { LlmProviderError, type LlmPort, type LlmResponse } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import { FallbackLlmAdapter } from './fallback.adapter.js';

const ok = (model: string): LlmResponse => ({
  json: {},
  model,
  latencyMs: 1,
  inputTokens: 1,
  outputTokens: 1,
});
const port = (provider: string, fn: () => Promise<LlmResponse>): LlmPort & { calls: number } => {
  const p = {
    provider,
    calls: 0,
    complete: async () => {
      p.calls++;
      return fn();
    },
  };
  return p;
};
const req = { systemFixed: '', systemDynamic: '', messages: [], schemaName: 's', jsonSchema: {} };
const silent = createLogger('t', { level: 'silent' });

describe('FallbackLlmAdapter', () => {
  it('usa el principal si responde, sin tocar el respaldo', async () => {
    const a = port('anthropic', async () => ok('m1'));
    const b = port('openai', async () => ok('m2'));
    const r = await new FallbackLlmAdapter(a, b, silent).complete(req);
    expect(r).toMatchObject({ model: 'm1', provider: 'anthropic' });
    expect(b.calls).toBe(0);
  });

  it('si el principal falla, responde el respaldo y queda registrado cuál fue', async () => {
    const a = port('anthropic', async () => {
      throw new LlmProviderError('timeout', 'anthropic', true);
    });
    const b = port('openai', async () => ok('m2'));
    const r = await new FallbackLlmAdapter(a, b, silent).complete(req);
    expect(r).toMatchObject({ model: 'm2', provider: 'openai' });
  });

  it('si ambos fallan, el error sube (la conversación irá a revisión)', async () => {
    const fail = (p: string) =>
      port(p, async () => {
        throw new LlmProviderError('caído', p, true);
      });
    await expect(
      new FallbackLlmAdapter(fail('anthropic'), fail('openai'), silent).complete(req),
    ).rejects.toBeInstanceOf(LlmProviderError);
  });

  it('errores que no son del proveedor (bugs) no se ocultan con el respaldo', async () => {
    const a = port('anthropic', async () => {
      throw new TypeError('bug');
    });
    const b = port('openai', async () => ok('m2'));
    await expect(new FallbackLlmAdapter(a, b, silent).complete(req)).rejects.toThrow('bug');
    expect(b.calls).toBe(0);
  });
});
