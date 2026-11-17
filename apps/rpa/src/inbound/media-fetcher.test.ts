import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import { HttpMediaFetcher } from './media-fetcher.js';

const logger = createLogger('t', { level: 'silent' });

function fetcher(fetchImpl: typeof fetch = async () => new Response('x')) {
  return new HttpMediaFetcher({ abayaBaseUrl: 'https://abaya.test/ysocial/', logger, fetchImpl });
}

describe('HttpMediaFetcher (D-010 / D-047)', () => {
  it('solo descarga de Azure Blob (https) o del mismo origen de Abaya', () => {
    const f = fetcher();
    expect(f.allowed('https://cuenta.blob.core.windows.net/c/a.ogg?sig=x')).not.toBeNull();
    expect(f.allowed('/blob/1/a.ogg')?.origin).toBe('https://abaya.test');
    expect(f.allowed('http://cuenta.blob.core.windows.net/a.ogg')).toBeNull();
    expect(f.allowed('https://169.254.169.254/latest/meta-data')).toBeNull();
    expect(f.allowed('https://blob.core.windows.net.evil.test/a.ogg')).toBeNull();
    expect(f.allowed('file:///C:/Windows/win.ini')).toBeNull();
    expect(f.allowed('blob:https://abaya.test/123')).toBeNull();
  });

  it('descarga sin redirecciones y respeta el tipo que anunció Abaya', async () => {
    let init: RequestInit | undefined;
    const f = fetcher(async (_u, i) => {
      init = i;
      return new Response(Buffer.from('OggS'), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
    const r = await f.fetch({
      kind: 'AUDIO',
      url: 'https://c.blob.core.windows.net/a.ogg',
      mimeType: 'audio/ogg',
    });
    expect(r).toEqual({ data: Buffer.from('OggS'), mimeType: 'audio/ogg' });
    expect(init?.redirect).toBe('error');
  });

  it('demasiado grande, error HTTP, vacío u origen no permitido: null', async () => {
    const big = fetcher(
      async () => new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024) } }),
    );
    const url = 'https://c.blob.core.windows.net/i.jpg';
    expect(await big.fetch({ kind: 'IMAGE', url })).toBeNull();
    expect(
      await fetcher(async () => new Response('no', { status: 403 })).fetch({ kind: 'IMAGE', url }),
    ).toBeNull();
    expect(await fetcher(async () => new Response('')).fetch({ kind: 'IMAGE', url })).toBeNull();
    expect(await fetcher().fetch({ kind: 'IMAGE', url: 'https://otro.test/i.jpg' })).toBeNull();
  });
});
