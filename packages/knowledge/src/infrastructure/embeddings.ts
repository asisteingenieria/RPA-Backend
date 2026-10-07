import type { EmbeddingProvider } from '../domain/ports.js';

/**
 * Proveedores de embeddings (K4) detrás del puerto `EmbeddingProvider`: se cambian por
 * configuración (`EMBEDDINGS_PROVIDER`). Llamadas HTTP directas según la referencia oficial:
 * - OpenAI `POST /v1/embeddings` { model, input[], encoding_format: "float" } → data[].embedding
 *   (máx. 2048 entradas y 300 000 tokens por petición).
 * - Voyage `POST https://api.voyageai.com/v1/embeddings` { model, input[], input_type:
 *   "document" | "query" } → data[].embedding (máx. 1000 entradas por petición).
 */

export class EmbeddingError extends Error {
  override name = 'EmbeddingError';
}

interface HttpEmbeddingOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const BATCH = 64;

abstract class HttpEmbeddings implements EmbeddingProvider {
  abstract readonly id: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(protected readonly o: HttpEmbeddingOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.o.model;
  }

  protected abstract url: string;
  protected abstract body(texts: string[], purpose: 'document' | 'query'): Record<string, unknown>;

  async embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(this.body(batch, purpose)),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
        });
      } catch {
        throw new EmbeddingError(`${this.id}: sin respuesta del proveedor de embeddings`);
      }
      if (!res.ok) throw new EmbeddingError(`${this.id}: el proveedor respondió ${res.status}`);
      const json = (await res.json()) as { data?: { embedding?: number[]; index?: number }[] };
      const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== batch.length || data.some((d) => !Array.isArray(d.embedding))) {
        throw new EmbeddingError(`${this.id}: respuesta de embeddings incompleta`);
      }
      out.push(...data.map((d) => d.embedding!));
    }
    return out;
  }
}

export class OpenAiEmbeddings extends HttpEmbeddings {
  readonly id = 'openai';
  protected url = 'https://api.openai.com/v1/embeddings';
  protected body(texts: string[]) {
    return { model: this.o.model, input: texts, encoding_format: 'float' };
  }
}

export class VoyageEmbeddings extends HttpEmbeddings {
  readonly id = 'voyage';
  protected url = 'https://api.voyageai.com/v1/embeddings';
  protected body(texts: string[], purpose: 'document' | 'query') {
    return { model: this.o.model, input: texts, input_type: purpose };
  }
}

export const DEFAULT_EMBEDDING_MODELS = {
  openai: 'text-embedding-3-small',
  voyage: 'voyage-4',
} as const;

/** `null` = sin embeddings: la búsqueda queda solo por texto completo. */
export function embeddingsFromConfig(cfg: {
  EMBEDDINGS_PROVIDER: 'none' | 'openai' | 'voyage';
  EMBEDDINGS_MODEL?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  VOYAGE_API_KEY?: string | undefined;
}): (EmbeddingProvider & { model: string }) | null {
  const model = (p: 'openai' | 'voyage') => cfg.EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDING_MODELS[p];
  if (cfg.EMBEDDINGS_PROVIDER === 'openai' && cfg.OPENAI_API_KEY) {
    return new OpenAiEmbeddings({ apiKey: cfg.OPENAI_API_KEY, model: model('openai') });
  }
  if (cfg.EMBEDDINGS_PROVIDER === 'voyage' && cfg.VOYAGE_API_KEY) {
    return new VoyageEmbeddings({ apiKey: cfg.VOYAGE_API_KEY, model: model('voyage') });
  }
  return null;
}
