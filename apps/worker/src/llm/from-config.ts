import type { AppConfig } from '@abaya/config';
import type { LlmPort } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { AnthropicLlmAdapter } from './adapters/anthropic.adapter.js';
import { FallbackLlmAdapter } from './adapters/fallback.adapter.js';
import { GeminiLlmAdapter } from './adapters/gemini.adapter.js';
import { OpenAiLlmAdapter } from './adapters/openai.adapter.js';
import { heuristicBrain } from './adapters/heuristic-brain.js';
import { ScriptedLlmAdapter } from './adapters/scripted.adapter.js';

export function providerAdapter(
  cfg: AppConfig,
  provider: AppConfig['LLM_PROVIDER'],
  model: string | undefined,
): LlmPort {
  switch (provider) {
    case 'anthropic':
      return new AnthropicLlmAdapter({
        ...(cfg.ANTHROPIC_API_KEY ? { apiKey: cfg.ANTHROPIC_API_KEY } : {}),
        ...(model ? { model } : {}),
        timeoutMs: cfg.LLM_TIMEOUT_MS,
      });
    case 'openai':
      if (!model) throw new Error('Falta el modelo de OpenAI (LLM_MODEL o LLM_FALLBACK_MODEL)');
      return new OpenAiLlmAdapter({
        model,
        ...(cfg.OPENAI_API_KEY ? { apiKey: cfg.OPENAI_API_KEY } : {}),
        timeoutMs: cfg.LLM_TIMEOUT_MS,
      });
    case 'gemini':
      if (!cfg.GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY');
      return new GeminiLlmAdapter({
        apiKey: cfg.GEMINI_API_KEY,
        ...(model ? { model } : {}),
        timeoutMs: cfg.LLM_TIMEOUT_MS,
      });
    case 'simulado':
      // Solo desarrollo (la configuración lo rechaza en producción): sin red ni API key.
      return new ScriptedLlmAdapter(heuristicBrain, cfg.LLM_SIMULATED_DELAY_MS);
    default:
      throw new Error(`LLM_PROVIDER ${provider} sin adaptador todavía`);
  }
}

/** Proveedor principal y, si está configurado, uno de respaldo (v1.5). */
export function llmFromConfig(cfg: AppConfig): LlmPort {
  const primary = providerAdapter(cfg, cfg.LLM_PROVIDER, cfg.LLM_MODEL);
  if (!cfg.LLM_FALLBACK_PROVIDER || cfg.LLM_PROVIDER === 'simulado') return primary;
  const backup = providerAdapter(cfg, cfg.LLM_FALLBACK_PROVIDER, cfg.LLM_FALLBACK_MODEL);
  return new FallbackLlmAdapter(primary, backup, createLogger('worker.llm'));
}
