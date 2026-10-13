import { LlmProviderError } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import { GeminiSpeechAdapter } from './gemini-speech.adapter.js';

const ok = (out: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-x',
    }),
    { status: 200 },
  );

const audio = { audio: Buffer.from('OggS-sintetico'), mimeType: 'audio/ogg' };

describe('GeminiSpeechAdapter (D-010)', () => {
  it('manda el audio en línea y devuelve la transcripción', async () => {
    let body: { contents: { parts: Record<string, unknown>[] }[] } | undefined;
    const stt = new GeminiSpeechAdapter({
      apiKey: 'k',
      model: 'gemini-x',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return ok({ transcript: ' quiero el plan de 30 ', intelligible: true });
      },
    });
    const r = await stt.transcribe(audio);
    expect(r).toMatchObject({
      transcript: 'quiero el plan de 30',
      intelligible: true,
      model: 'gemini-x',
    });
    expect(body!.contents[0]!.parts[1]).toEqual({
      inlineData: { mimeType: 'audio/ogg', data: audio.audio.toString('base64') },
    });
  });

  it('sin habla clara: ininteligible', async () => {
    const stt = new GeminiSpeechAdapter({
      apiKey: 'k',
      fetchImpl: async () => ok({ transcript: '', intelligible: false }),
    });
    expect((await stt.transcribe(audio)).intelligible).toBe(false);
  });

  it('429 dos veces: outage (pausa D-009); 400: falla solo esta nota', async () => {
    let calls = 0;
    const busy = new GeminiSpeechAdapter({
      apiKey: 'k',
      fetchImpl: async () => {
        calls++;
        return new Response('{}', { status: 429 });
      },
    });
    const e1 = await busy.transcribe(audio).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(LlmProviderError);
    expect((e1 as LlmProviderError).outage).toBe(true);
    expect(calls).toBe(2);

    const bad = new GeminiSpeechAdapter({
      apiKey: 'k',
      fetchImpl: async () => new Response('{}', { status: 400 }),
    });
    const e2 = await bad.transcribe(audio).catch((e: unknown) => e);
    expect((e2 as LlmProviderError).outage).toBe(false);
  });
});
