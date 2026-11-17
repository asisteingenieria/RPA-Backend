import { MAX_AUDIO_BYTES, MAX_INBOUND_IMAGE_BYTES, type InboundMedia } from '@abaya/domain';
import type { Logger } from '@abaya/logger';

/** Adjunto del cliente ya descargado (bytes en memoria; nunca se escribe en disco). */
export interface FetchedMedia {
  data: Buffer;
  mimeType: string | null;
}

/**
 * D-010 / D-047: descarga la nota de voz o la imagen que anunció Abaya. null = no se pudo (el
 * mensaje se guarda igual, sin archivo, y el worker le pide al cliente que escriba).
 */
export interface MediaFetcher {
  fetch(media: InboundMedia): Promise<FetchedMedia | null>;
}

/** Azure Blob de ySocial (el enlace es un SAS: se descarga sin la sesión de Abaya). */
const AZURE_BLOB_HOST = /\.blob\.core\.windows\.net$/i;

/**
 * Descarga por HTTP con defensas contra SSRF: solo `https` a Azure Blob o el mismo origen de
 * Abaya, sin redirecciones, con tiempo y tamaño máximos. Sin contenido ni URL en logs (la URL
 * lleva la firma SAS): solo el tipo, el motivo y el tamaño.
 */
export class HttpMediaFetcher implements MediaFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly abayaOrigin: URL | null;

  constructor(
    private readonly d: {
      abayaBaseUrl: string | null;
      logger: Logger;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.fetchImpl = d.fetchImpl ?? fetch;
    this.abayaOrigin = d.abayaBaseUrl ? safeUrl(d.abayaBaseUrl) : null;
  }

  /** ¿Se puede descargar de aquí? Exportado para las pruebas. */
  allowed(raw: string): URL | null {
    const url = safeUrl(raw, this.abayaOrigin ?? undefined);
    if (!url) return null;
    if (this.abayaOrigin && url.origin === this.abayaOrigin.origin) return url;
    if (url.protocol === 'https:' && AZURE_BLOB_HOST.test(url.hostname)) return url;
    return null;
  }

  async fetch(media: InboundMedia): Promise<FetchedMedia | null> {
    const max = media.kind === 'IMAGE' ? MAX_INBOUND_IMAGE_BYTES : MAX_AUDIO_BYTES;
    const url = this.allowed(media.url);
    if (!url) return this.fail(media, 'origen no permitido');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.d.timeoutMs ?? 15_000),
      });
    } catch (err) {
      return this.fail(media, err instanceof Error ? err.name : 'error de red');
    }
    if (!res.ok || !res.body) return this.fail(media, `http ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > max) return this.fail(media, 'demasiado grande');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > max) return this.fail(media, 'demasiado grande');
        chunks.push(Buffer.from(chunk));
      }
    } catch (err) {
      return this.fail(media, err instanceof Error ? err.name : 'lectura interrumpida');
    }
    if (!size) return this.fail(media, 'vacío');
    const header = res.headers.get('content-type');
    // El tipo que anunció Abaya manda; Azure a veces responde application/octet-stream.
    const mimeType =
      media.mimeType ?? (header && !header.startsWith('application/') ? header : null);
    return { data: Buffer.concat(chunks), mimeType };
  }

  private fail(media: InboundMedia, reason: string): null {
    this.d.logger.warn({ kind: media.kind, reason }, 'adjunto del cliente sin descargar');
    return null;
  }
}

function safeUrl(raw: string, base?: URL): URL | null {
  try {
    const u = new URL(raw, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}
