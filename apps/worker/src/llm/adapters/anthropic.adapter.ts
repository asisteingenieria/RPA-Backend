import Anthropic from '@anthropic-ai/sdk';
import { LlmProviderError, type LlmPort, type LlmRequest, type LlmResponse } from '@abaya/domain';
import { providerJsonSchema } from '../json-schema.js';

export interface AnthropicAdapterOptions {
  apiKey?: string;
  model?: string;
  /** Profundidad de razonamiento: `low` para chat (latencia y costo). */
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  /** Si el modelo declina por política, la API reintenta en otro modelo (solo Claude API). */
  serverFallback?: boolean;
}

/**
 * Adaptador de Claude (sección 6.3.6):
 * - Salida estructurada con JSON Schema (`output_config.format`).
 * - Prompt caching de la parte fija del system prompt.
 * - Timeout de 15 s y 1 reintento (SDK).
 * Los modelos Claude actuales no aceptan `temperature`; el control equivalente es `effort`.
 */
export class AnthropicLlmAdapter implements LlmPort {
  readonly provider = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly opts: AnthropicAdapterOptions = {}) {
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      timeout: opts.timeoutMs ?? 15_000,
      maxRetries: 1,
    });
    this.model = opts.model ?? 'claude-opus-5-5';
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 2_000,
          ...(this.opts.serverFallback !== false
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
            : {}),
          system: [
            { type: 'text', text: req.systemFixed, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: req.systemDynamic },
          ],
          messages: req.messages,
          output_config: {
            effort: this.opts.effort ?? 'low',
            format: { type: 'json_schema', schema: providerJsonSchema(req.jsonSchema) },
          },
        },
        req.timeoutMs ? { timeout: req.timeoutMs } : undefined,
      );
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
        throw new LlmProviderError(`anthropic ${err.status}`, this.provider, true);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LlmProviderError(`anthropic ${err.status ?? 'error'}`, this.provider, false);
      }
      throw new LlmProviderError('anthropic sin respuesta', this.provider, true);
    }

    if (res.stop_reason === 'refusal') {
      throw new LlmProviderError('anthropic refusal', this.provider, false);
    }
    if (res.stop_reason === 'max_tokens') {
      throw new LlmProviderError('anthropic max_tokens', this.provider, false);
    }
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text; // lo rechazará el validador de esquema
    }
    return {
      json,
      model: res.model,
      latencyMs: Date.now() - started,
      inputTokens:
        res.usage.input_tokens +
        (res.usage.cache_read_input_tokens ?? 0) +
        (res.usage.cache_creation_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
  }
}
