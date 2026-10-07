import { LlmProviderError, type LlmPort, type LlmRequest, type LlmResponse } from '@abaya/domain';
import OpenAI from 'openai';
import { providerJsonSchema } from '../json-schema.js';

export interface OpenAiAdapterOptions {
  apiKey?: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  /** Para Azure OpenAI u otro endpoint compatible contratado por Claro. */
  baseURL?: string;
}

/**
 * Segundo adaptador para la comparación con la suite de evaluación (sección 6.3.7).
 * Salida estructurada estricta (`response_format: json_schema`). El caché del prefijo es
 * automático en este proveedor cuando el inicio del prompt es estable (parte fija primero).
 */
export class OpenAiLlmAdapter implements LlmPort {
  readonly provider = 'openai';
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenAiAdapterOptions) {
    this.client = new OpenAI({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      timeout: opts.timeoutMs ?? 8_000,
      maxRetries: 1,
    });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      res = await this.client.chat.completions.create(
        {
          model: this.opts.model,
          temperature: this.opts.temperature ?? 0.2,
          messages: [
            { role: 'system', content: req.systemFixed },
            { role: 'system', content: req.systemDynamic },
            ...req.messages,
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: req.schemaName,
              strict: true,
              schema: providerJsonSchema(req.jsonSchema),
            },
          },
        },
        req.timeoutMs ? { timeout: req.timeoutMs } : undefined,
      );
    } catch (err) {
      const status = err instanceof OpenAI.APIError ? err.status : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      throw new LlmProviderError(`openai ${status ?? 'sin respuesta'}`, this.provider, retryable);
    }
    const choice = res.choices[0];
    if (!choice || choice.finish_reason !== 'stop' || choice.message.refusal) {
      throw new LlmProviderError(
        `openai ${choice?.finish_reason ?? 'vacío'}`,
        this.provider,
        false,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(choice.message.content ?? '');
    } catch {
      json = choice.message.content;
    }
    return {
      json,
      model: res.model,
      latencyMs: Date.now() - started,
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    };
  }
}
