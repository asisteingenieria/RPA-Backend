import { LlmProviderError } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import { GeminiLlmAdapter } from './gemini.adapter.js';

interface Call {
  url: string;
  key: string | null;
  body: {
    systemInstruction: unknown;
    contents: { role: string }[];
    generationConfig: {
      temperature: number;
      thinkingConfig?: unknown;
      responseJsonSchema: Record<string, unknown>;
    };
  };
}

const okBody = (text: string, finishReason = 'STOP') => ({
  candidates: [
    {
      content: { parts: [{ text: 'pensando…', thought: true }, { text }] },
      finishReason,
    },
  ],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10 },
  modelVersion: 'gemini-3.8-flash',
});

/** fetch falso: responde en orden lo que devuelvan las funciones y registra cada llamada. */
function fakeFetch(calls: Call[], ...replies: (() => Response)[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url,
      key: headers['x-goog-api-key'] ?? null,
      body: JSON.parse(init.body as string),
    });
    const reply = replies[calls.length - 1] ?? replies[replies.length - 1]!;
    return reply();
  }) as unknown as typeof fetch;
}
const json =
  (b: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(b), { status });

const req = {
  systemFixed: 'reglas',
  systemDynamic: 'estado',
  messages: [
    { role: 'user' as const, content: 'hola' },
    { role: 'assistant' as const, content: '{"reply":"hola"}' },
    { role: 'user' as const, content: '¿precio?' },
  ],
  schemaName: 'turno',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { reply: { type: 'string', maxLength: 500 } },
    required: ['reply'],
    additionalProperties: false,
  },
};

describe('GeminiLlmAdapter', () => {
  it('arma generateContent: system en dos partes, roles user/model y salida JSON con esquema', async () => {
    const calls: Call[] = [];
    const llm = new GeminiLlmAdapter({
      apiKey: 'k-prueba',
      fetchImpl: fakeFetch(calls, json(okBody('{"reply":"listo"}'))),
    });
    const r = await llm.complete(req);

    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    expect(calls[0]!.key).toBe('k-prueba');
    const body = calls[0]!.body;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'reglas' }, { text: 'estado' }] });
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.generationConfig).toMatchObject({
      temperature: 0.2,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'low' },
      responseJsonSchema: {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
      },
    });
    expect(body.generationConfig.responseJsonSchema.$schema).toBeUndefined();

    // Las partes de razonamiento no se mezclan con la respuesta; sí se cuentan sus tokens.
    expect(r).toMatchObject({
      json: { reply: 'listo' },
      model: 'gemini-3.8-flash',
      inputTokens: 120,
      outputTokens: 40,
    });
  });

  it('el modelo de la versión publicada del agente manda sobre el del adaptador', async () => {
    const calls: Call[] = [];
    const llm = new GeminiLlmAdapter({
      apiKey: 'k',
      model: 'gemini-3.8-flash',
      fetchImpl: fakeFetch(calls, json(okBody('{}'))),
    });
    await llm.complete({ ...req, model: 'gemini-2.5-pro', temperature: 0 });
    expect(calls[0]!.url).toContain('/models/gemini-2.5-pro:generateContent');
    expect(calls[0]!.body.generationConfig.temperature).toBe(0);
    // Gemini 2.x no acepta thinkingLevel.
    expect(calls[0]!.body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('texto que no es JSON pasa tal cual (lo rechaza el validador de esquema)', async () => {
    const llm = new GeminiLlmAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch([], json(okBody('no es json'))),
    });
    expect((await llm.complete(req)).json).toBe('no es json');
  });

  it('429 o 5xx: un reintento y, si vuelve a fallar, error reintentable', async () => {
    const calls: Call[] = [];
    const llm = new GeminiLlmAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch(calls, json({}, 503), json(okBody('{"reply":"ok"}'))),
    });
    expect((await llm.complete(req)).json).toEqual({ reply: 'ok' });
    expect(calls).toHaveLength(2);

    const calls2: Call[] = [];
    const failing = new GeminiLlmAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch(calls2, json({}, 429)),
    });
    const err = await failing.complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err).toMatchObject({ provider: 'gemini', retryable: true, message: 'gemini 429' });
    expect(calls2).toHaveLength(2);
  });

  it('400 (petición o clave inválida): sin reintento y no reintentable', async () => {
    const calls: Call[] = [];
    const llm = new GeminiLlmAdapter({ apiKey: 'k', fetchImpl: fakeFetch(calls, json({}, 400)) });
    await expect(llm.complete(req)).rejects.toMatchObject({
      retryable: false,
      message: 'gemini 400',
    });
    expect(calls).toHaveLength(1);
  });

  it('sin respuesta de la red: reintenta y queda como reintentable', async () => {
    let n = 0;
    const llm = new GeminiLlmAdapter({
      apiKey: 'k',
      fetchImpl: (async () => {
        n++;
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(llm.complete(req)).rejects.toMatchObject({
      retryable: true,
      message: 'gemini sin respuesta',
    });
    expect(n).toBe(2);
  });

  it('corte por tope de tokens, seguridad o prompt bloqueado: error no reintentable', async () => {
    const cut = new GeminiLlmAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch([], json(okBody('{"reply":"a', 'MAX_TOKENS'))),
    });
    await expect(cut.complete(req)).rejects.toMatchObject({
      retryable: false,
      message: 'gemini MAX_TOKENS',
    });

    const blocked = new GeminiLlmAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch([], json({ promptFeedback: { blockReason: 'SAFETY' } })),
    });
    await expect(blocked.complete(req)).rejects.toMatchObject({
      retryable: false,
      message: 'gemini bloqueado SAFETY',
    });
  });
});
