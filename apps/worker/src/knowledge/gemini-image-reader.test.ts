import { ImageReadError } from '@abaya/knowledge';
import { describe, expect, it } from 'vitest';
import { GeminiImageReader, toCards } from './gemini-image-reader.js';

const reply = (text: string, finishReason = 'STOP') =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason }] }), {
    status: 200,
  });

describe('D-011: lectura de imágenes de planes', () => {
  it('limpia lo que devuelve el modelo: descarta tarjetas sin datos o sin precio', () => {
    const none = {
      sharedDataText: null,
      includesText: null,
      unlimitedAppsText: null,
      callsText: null,
    };
    expect(
      toCards([
        { code: '38327', dataText: '65 GB', priceCop: 56900 },
        {
          code: 'x y',
          dataText: 'GB ILIMITADAS',
          priceCop: 99900.4,
          sharedDataText: '70 GB  para compartir',
          includesText: 'Claro video + Prime video',
          callsText: '  ',
        },
        { code: null, dataText: '', priceCop: 1 },
        { code: null, dataText: '45 GB', priceCop: 0 },
      ]),
    ).toEqual([
      { code: '38327', dataText: '65 GB', priceCop: 56900, ...none },
      {
        code: null,
        dataText: 'GB ILIMITADAS',
        priceCop: 99900,
        ...none,
        // D-014: el resto de la tarjeta, normalizado (espacios) y vacío → null.
        sharedDataText: '70 GB para compartir',
        includesText: 'Claro video + Prime video',
      },
    ]);
    expect(() => toCards('nada')).toThrow(ImageReadError);
  });

  it('envía la imagen en línea y lee la respuesta JSON', async () => {
    let body: { contents: { parts: { inlineData?: { mimeType: string } }[] }[] } | undefined;
    const reader = new GeminiImageReader({
      apiKey: 'k',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return reply(
          JSON.stringify({ cards: [{ code: null, dataText: '50 GB', priceCop: 47900 }] }),
        );
      },
    });
    expect(await reader.read(new Uint8Array([1, 2, 3]), 'image/png')).toMatchObject([
      { code: null, dataText: '50 GB', priceCop: 47900 },
    ]);
    expect(body!.contents[0]!.parts[1]!.inlineData!.mimeType).toBe('image/png');
  });

  it('un 400 es error de contenido; un 503 se reintenta y queda como transitorio', async () => {
    const bad = new GeminiImageReader({
      apiKey: 'k',
      fetchImpl: async () => new Response('', { status: 400 }),
    });
    await expect(bad.read(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      transient: false,
    });
    let calls = 0;
    const down = new GeminiImageReader({
      apiKey: 'k',
      fetchImpl: async () => {
        calls++;
        return new Response('', { status: 503 });
      },
    });
    await expect(down.read(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      transient: true,
    });
    expect(calls).toBe(2);
  });
});
