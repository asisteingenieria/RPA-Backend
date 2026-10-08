import { LlmProviderError, type LlmPort, type LlmRequest, type LlmResponse } from '@abaya/domain';
import { providerJsonSchema } from '../json-schema.js';

export interface GeminiAdapterOptions {
  apiKey: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  /** Razonamiento de los modelos Gemini 3+: `low` para chat (latencia y costo). */
  thinkingLevel?: 'low' | 'medium' | 'high';
  /** Para pruebas o un endpoint propio; por defecto la API de Gemini (Google AI Studio). */
  baseURL?: string;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

/**
 * Adaptador de Gemini por la API REST `models/{modelo}:generateContent` (sin SDK: una sola
 * llamada HTTP, como los embeddings de `@abaya/knowledge`).
 * - Salida estructurada: `responseMimeType: application/json` + `responseJsonSchema`.
 * - Parte fija del system prompt primero: Gemini cachea el prefijo repetido de forma implícita.
 * - Timeout de 8 s y 1 reintento solo si el error es transitorio (429, 5xx, sin respuesta).
 */
export class GeminiLlmAdapter implements LlmPort {
  readonly provider = 'gemini';
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiAdapterOptions) {
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const model = req.model ?? this.model;
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.systemFixed }, { text: req.systemDynamic }] },
      contents: req.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: req.temperature ?? this.opts.temperature ?? 0.2,
        // En Gemini el razonamiento cuenta dentro de este tope.
        maxOutputTokens: 4_000,
        responseMimeType: 'application/json',
        responseJsonSchema: providerJsonSchema(req.jsonSchema),
        // Los Gemini 2.x no aceptan thinkingLevel (usan thinkingBudget): se deja su valor por defecto.
        ...(model.startsWith('gemini-2')
          ? {}
          : { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel ?? 'low' } }),
      },
    });

    const res = await this.call(model, body, req.timeoutMs ?? this.opts.timeoutMs ?? 8_000);
    if (res.promptFeedback?.blockReason) {
      throw new LlmProviderError(
        `gemini bloqueado ${res.promptFeedback.blockReason}`,
        this.provider,
        false,
      );
    }
    const candidate = res.candidates?.[0];
    if (!candidate || candidate.finishReason !== 'STOP') {
      throw new LlmProviderError(
        `gemini ${candidate?.finishReason ?? 'vacío'}`,
        this.provider,
        false,
      );
    }
    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text; // lo rechazará el validador de esquema
    }
    const usage = res.usageMetadata ?? {};
    return {
      json,
      model: res.modelVersion ?? model,
      latencyMs: Date.now() - started,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    };
  }

  /** Una llamada con 1 reintento si el fallo es transitorio. */
  private async call(model: string, body: string, timeoutMs: number): Promise<GeminiResponse> {
    const url = `${this.opts.baseURL ?? BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
    let last: LlmProviderError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'x-goog-api-key': this.opts.apiKey, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        last = new LlmProviderError('gemini sin respuesta', this.provider, true);
        continue;
      }
      if (res.ok) return (await res.json()) as GeminiResponse;
      const retryable = res.status === 429 || res.status >= 500;
      last = new LlmProviderError(`gemini ${res.status}`, this.provider, retryable);
      if (!retryable) throw last;
    }
    throw last!;
  }
}
