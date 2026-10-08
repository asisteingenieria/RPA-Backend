import type { EmbeddingProvider } from '../domain/ports.js';

/**
 * Proveedores de embeddings (K4) detrás del puerto `EmbeddingProvider`: se cambian por
 * configuración (`EMBEDDINGS_PROVIDER`). Llamadas HTTP directas según la referencia oficial:
 * - OpenAI `POST /v1/embeddings` { model, input[], encoding_format: "float" } → data[].embedding
 *   (máx. 2048 entradas y 300 000 tokens por petición).
 * - Voyage `POST https://api.voyageai.com/v1/embeddings` { model, input[], input_type:
 *   "document" | "query" } → data[].embedding (máx. 1000 entradas por petición).
 * - Gemini `POST /v1beta/models/{modelo}:batchEmbedContents` { requests[]: { model, content,
 *   taskType: RETRIEVAL_DOCUMENT | RETRIEVAL_QUERY, outputDimensionality } } → embeddings[].values
 *   (máx. 100 entradas por petición; clave en la cabecera `x-goog-api-key`).
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

  protected headers(): Record<string, string> {
    return { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' };
  }

  /** Vectores de la respuesta en el orden de la entrada (`undefined` si falta alguno). */
  protected vectors(json: unknown): (number[] | undefined)[] {
    const data = [...((json as { data?: { embedding?: number[]; index?: number }[] }).data ?? [])];
    return data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  }

  async embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(this.body(batch, purpose)),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
        });
      } catch {
        throw new EmbeddingError(`${this.id}: sin respuesta del proveedor de embeddings`);
      }
      if (!res.ok) throw new EmbeddingError(`${this.id}: el proveedor respondió ${res.status}`);
      const vectors = this.vectors(await res.json());
      if (vectors.length !== batch.length || vectors.some((v) => !Array.isArray(v))) {
        throw new EmbeddingError(`${this.id}: respuesta de embeddings incompleta`);
      }
      out.push(...(vectors as number[][]));
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

/** 768 dimensiones: buena calidad, poco espacio en `VersionChunk` y dentro del límite de pgvector. */
const GEMINI_DIMENSIONS = 768;

export class GeminiEmbeddings extends HttpEmbeddings {
  readonly id = 'gemini';
  protected get url() {
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.o.model)}:batchEmbedContents`;
  }
  protected override headers() {
    return { 'x-goog-api-key': this.o.apiKey, 'content-type': 'application/json' };
  }
  protected body(texts: string[], purpose: 'document' | 'query') {
    return {
      requests: texts.map((text) => ({
        model: `models/${this.o.model}`,
        content: { parts: [{ text }] },
        taskType: purpose === 'document' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY',
        outputDimensionality: GEMINI_DIMENSIONS,
      })),
    };
  }
  protected override vectors(json: unknown) {
    return ((json as { embeddings?: { values?: number[] }[] }).embeddings ?? []).map(
      (e) => e.values,
    );
  }
}

export const DEFAULT_EMBEDDING_MODELS = {
  openai: 'text-embedding-3-small',
  voyage: 'voyage-4',
  gemini: 'gemini-embedding-2',
} as const;

/** `null` = sin embeddings: la búsqueda queda solo por texto completo. */
export function embeddingsFromConfig(cfg: {
  EMBEDDINGS_PROVIDER: 'none' | 'openai' | 'voyage' | 'gemini';
  EMBEDDINGS_MODEL?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  VOYAGE_API_KEY?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
}): (EmbeddingProvider & { model: string }) | null {
  const model = (p: keyof typeof DEFAULT_EMBEDDING_MODELS) =>
    cfg.EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDING_MODELS[p];
  if (cfg.EMBEDDINGS_PROVIDER === 'openai' && cfg.OPENAI_API_KEY) {
    return new OpenAiEmbeddings({ apiKey: cfg.OPENAI_API_KEY, model: model('openai') });
  }
  if (cfg.EMBEDDINGS_PROVIDER === 'voyage' && cfg.VOYAGE_API_KEY) {
    return new VoyageEmbeddings({ apiKey: cfg.VOYAGE_API_KEY, model: model('voyage') });
  }
  if (cfg.EMBEDDINGS_PROVIDER === 'gemini' && cfg.GEMINI_API_KEY) {
    return new GeminiEmbeddings({ apiKey: cfg.GEMINI_API_KEY, model: model('gemini') });
  }
  return null;
}
