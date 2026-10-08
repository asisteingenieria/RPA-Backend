import { describe, expect, it } from 'vitest';
import { TextExtractor } from './document-parser.js';
import {
  GeminiEmbeddings,
  OpenAiEmbeddings,
  VoyageEmbeddings,
  embeddingsFromConfig,
} from './embeddings.js';
import { htmlTitle, htmlToText } from './html-text.js';
import { SafeWebFetcher, checkWebUrl, isPublicAddress } from './web-fetcher.js';

describe('SSRF: direcciones', () => {
  it.each([
    ['10.0.0.5', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false], // metadatos de nube
    ['172.20.1.1', false],
    ['192.168.1.10', false],
    ['100.64.0.1', false], // CGNAT
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:10.0.0.1', false],
    ['::ffff:127.0.0.1', false],
    ['64:ff9b::192.168.0.1', false],
    ['8.8.8.8', true],
    ['181.49.1.1', true],
    ['2800:3f0:4005::200e', true],
    ['no-es-ip', false],
  ])('%s → pública: %s', (ip, pub) => {
    expect(isPublicAddress(ip)).toBe(pub);
  });

  it.each([
    ['http://claro.com.co/planes', 'solo se permiten direcciones https://'],
    ['ftp://claro.com.co', 'solo se permiten direcciones https://'],
    ['file:///etc/passwd', 'solo se permiten direcciones https://'],
    ['https://user:clave@claro.com.co', 'usuario ni contraseña'],
    ['https://claro.com.co:8443/x', 'puerto 443'],
    ['https://127.0.0.1/admin', 'red interna'],
    ['https://[::1]/', 'red interna'],
    ['https://localhost/', 'red interna'],
    ['https://servidor.internal/', 'red interna'],
    ['no es url', 'no es una URL válida'],
  ])('rechaza %s', (url, msg) => {
    expect(() => checkWebUrl(url)).toThrow(msg);
  });

  it('acepta https público', () => {
    expect(checkWebUrl('https://www.claro.com.co/personas/planes').hostname).toBe(
      'www.claro.com.co',
    );
  });

  it('un nombre que resuelve a una IP privada (o mezclada) se rechaza antes de conectar', async () => {
    const f = (addrs: string[]) =>
      new SafeWebFetcher({
        resolve: async () =>
          addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      });
    await expect(f(['10.1.2.3']).resolvePublic('trampa.example')).rejects.toThrow('red interna');
    await expect(f(['8.8.8.8', '127.0.0.1']).resolvePublic('mixta.example')).rejects.toThrow(
      'red interna',
    );
    await expect(f(['8.8.8.8']).resolvePublic('ok.example')).resolves.toEqual({
      address: '8.8.8.8',
      family: 4,
    });
    // Así también una redirección a la red interna: cada salto pasa por checkWebUrl + resolvePublic.
    await expect(f(['169.254.169.254']).fetch('https://metadata.example/latest')).rejects.toThrow(
      'red interna',
    );
  });
});

describe('htmlToText', () => {
  it('se queda con el contenido principal, sin scripts ni navegación', () => {
    const html = `<!doctype html><html><head><title>Planes &amp; precios</title><script>alert(1)</script></head>
      <body><nav>Inicio | Planes</nav><header>Logo</header>
      <main><h1>Preguntas frecuentes</h1><p>La portabilidad tarda &aacute;gil, hasta 3 d&iacute;as.</p>
      <ul><li>Requisito A</li><li>Requisito B</li></ul><style>.x{}</style></main>
      <footer>© Claro</footer></body></html>`;
    expect(htmlTitle(html)).toBe('Planes & precios');
    const text = htmlToText(html);
    expect(text).toContain('## Preguntas frecuentes');
    expect(text).toContain('La portabilidad tarda ágil, hasta 3 días.');
    expect(text).toContain('Requisito B');
    expect(text).not.toMatch(/alert|Inicio \| Planes|Logo|© Claro|\.x\{/);
  });
});

describe('embeddings: forma de las peticiones (referencia oficial)', () => {
  function fakeFetch(calls: { url: string; body: unknown; auth: string | null }[]) {
    return (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      calls.push({ url, body, auth: new Headers(init.headers).get('authorization') });
      // Respuesta desordenada a propósito: se reordena por `index`.
      const data = body.input
        .map((_, i) => ({ object: 'embedding', index: i, embedding: [i, 1] }))
        .reverse();
      return new Response(JSON.stringify({ object: 'list', data }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('OpenAI: /v1/embeddings con model, input y encoding_format float', async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const e = new OpenAiEmbeddings({
      apiKey: 'sk-prueba',
      model: 'text-embedding-3-small',
      fetchImpl: fakeFetch(calls),
    });
    expect(await e.embed(['a', 'b', 'c'], 'document')).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
    expect(calls[0]).toEqual({
      url: 'https://api.openai.com/v1/embeddings',
      body: { model: 'text-embedding-3-small', input: ['a', 'b', 'c'], encoding_format: 'float' },
      auth: 'Bearer sk-prueba',
    });
  });

  it('Voyage: input_type document/query', async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const e = new VoyageEmbeddings({
      apiKey: 'pa-prueba',
      model: 'voyage-4',
      fetchImpl: fakeFetch(calls),
    });
    await e.embed(['q'], 'query');
    expect(calls[0]).toMatchObject({
      url: 'https://api.voyageai.com/v1/embeddings',
      body: { model: 'voyage-4', input: ['q'], input_type: 'query' },
    });
  });

  it('Gemini: batchEmbedContents con taskType, 768 dimensiones y clave en x-goog-api-key', async () => {
    const calls: { url: string; body: { requests: { taskType: string }[] }; key: string | null }[] =
      [];
    const e = new GeminiEmbeddings({
      apiKey: 'g-prueba',
      model: 'gemini-embedding-2',
      fetchImpl: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { requests: { taskType: string }[] };
        calls.push({
          url,
          body,
          key: (init.headers as Record<string, string>)['x-goog-api-key'] ?? null,
        });
        const embeddings = body.requests.map((_, i) => ({ values: [i, 2] }));
        return new Response(JSON.stringify({ embeddings }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await e.embed(['a', 'b'], 'document')).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents',
    );
    expect(calls[0]!.key).toBe('g-prueba');
    expect(calls[0]!.body.requests[0]).toEqual({
      model: 'models/gemini-embedding-2',
      content: { parts: [{ text: 'a' }] },
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 768,
    });
    await e.embed(['q'], 'query');
    expect(calls[1]!.body.requests[0]!.taskType).toBe('RETRIEVAL_QUERY');
  });

  it('Gemini: respuesta con menos vectores que textos → EmbeddingError', async () => {
    const e = new GeminiEmbeddings({
      apiKey: 'g',
      model: 'gemini-embedding-2',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ embeddings: [{ values: [1] }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await expect(e.embed(['a', 'b'], 'document')).rejects.toThrow('incompleta');
  });

  it('error del proveedor → EmbeddingError (la ingesta reintenta)', async () => {
    const e = new OpenAiEmbeddings({
      apiKey: 'x',
      model: 'm',
      fetchImpl: (async () => new Response('no', { status: 429 })) as unknown as typeof fetch,
    });
    await expect(e.embed(['a'], 'document')).rejects.toThrow('respondió 429');
  });

  it('sin proveedor o sin API key → null (búsqueda solo por texto)', () => {
    expect(embeddingsFromConfig({ EMBEDDINGS_PROVIDER: 'none' })).toBeNull();
    expect(embeddingsFromConfig({ EMBEDDINGS_PROVIDER: 'voyage' })).toBeNull();
    expect(
      embeddingsFromConfig({ EMBEDDINGS_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })?.model,
    ).toBe('text-embedding-3-small');
    expect(embeddingsFromConfig({ EMBEDDINGS_PROVIDER: 'gemini' })).toBeNull();
    expect(
      embeddingsFromConfig({ EMBEDDINGS_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })?.model,
    ).toBe('gemini-embedding-2');
  });
});

/** PDF mínimo válido con un texto (para no depender de archivos de prueba binarios). */
function tinyPdf(text: string): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('TextExtractor', () => {
  const x = new TextExtractor();

  it('PDF con unpdf', async () => {
    expect(await x.extractText(tinyPdf('Cobertura nacional'), 'pdf')).toContain(
      'Cobertura nacional',
    );
  });

  it('PDF dañado → mensaje claro', async () => {
    await expect(x.extractText(new TextEncoder().encode('%PDF-1.4 roto'), 'pdf')).rejects.toThrow(
      /PDF/,
    );
  });

  it('DOCX dañado → mensaje claro', async () => {
    await expect(x.extractText(new Uint8Array([0x50, 0x4b, 3, 4, 1]), 'docx')).rejects.toThrow(
      'documento de Word',
    );
  });

  it('TXT, MD y HTML', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(await x.extractText(enc('hola'), 'txt')).toBe('hola');
    expect(await x.extractText(enc('# Título'), 'md')).toBe('# Título');
    expect(await x.extractText(enc('<main><p>Uno</p><script>x</script></main>'), 'html')).toBe(
      'Uno',
    );
  });
});
