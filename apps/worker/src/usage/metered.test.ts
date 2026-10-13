import type { LlmPort, ModelUsage, SpeechToTextPort } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import { meteredLlm, meteredSpeech } from './metered.js';

describe('consumo de tokens', () => {
  it('registra cada llamada al modelo con su uso, sin cambiar la respuesta', async () => {
    const seen: ModelUsage[] = [];
    const llm: LlmPort = {
      provider: 'gemini',
      complete: async () => ({
        json: { ok: 1 },
        model: 'gemini-3.8-flash',
        latencyMs: 900,
        inputTokens: 1200,
        outputTokens: 80,
      }),
    };
    const m = meteredLlm(llm, { record: (u) => seen.push(u) }, 'EVAL');
    expect((await m.complete({} as never)).json).toEqual({ ok: 1 });
    expect(seen).toEqual([
      {
        kind: 'EVAL',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        inputTokens: 1200,
        outputTokens: 80,
        latencyMs: 900,
      },
    ]);
  });

  it('voz a texto: usa los tokens que informa el proveedor (0 si no los trae)', async () => {
    const seen: ModelUsage[] = [];
    const speech: SpeechToTextPort = {
      provider: 'gemini',
      transcribe: async () => ({
        transcript: 'hola',
        intelligible: true,
        model: 'm',
        latencyMs: 300,
        inputTokens: 500,
      }),
    };
    await meteredSpeech(speech, { record: (u) => seen.push(u) }, 'VOICE')!.transcribe({} as never);
    expect(seen[0]).toMatchObject({ kind: 'VOICE', inputTokens: 500, outputTokens: 0 });
    expect(meteredSpeech(null, { record: () => undefined }, 'VOICE')).toBeNull();
  });
});
