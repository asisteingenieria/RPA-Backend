import { LlmProviderError, type LlmPort, type LlmRequest, type LlmResponse } from '@abaya/domain';

export type ScriptStep = unknown | ((req: LlmRequest) => unknown) | LlmProviderError;

/**
 * LLM simulado para pruebas y para la suite de evaluación sin red: devuelve, en orden,
 * las salidas guionadas (o el resultado de una función sobre la petición).
 */
export class ScriptedLlmAdapter implements LlmPort {
  readonly provider = 'scripted';
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly steps: ScriptStep[] | ((req: LlmRequest) => unknown),
    /** Latencia media simulada (±50 %), para pruebas de carga realistas. 0 = inmediata. */
    private readonly delayMs = 0,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const started = Date.now();
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs * (0.5 + Math.random())));
    }
    const step = Array.isArray(this.steps) ? this.steps.shift() : this.steps;
    if (step === undefined) throw new LlmProviderError('guion agotado', this.provider, false);
    if (step instanceof LlmProviderError) throw step;
    const json = typeof step === 'function' ? (step as (r: LlmRequest) => unknown)(req) : step;
    return {
      json,
      model: 'scripted-1',
      latencyMs: Math.max(1, Date.now() - started),
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
