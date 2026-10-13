import type { AppConfig } from '@abaya/config';
import type { SpeechRequest, SpeechResult, SpeechToTextPort } from '@abaya/domain';
import { GeminiSpeechAdapter } from './gemini-speech.adapter.js';

/**
 * Solo desarrollo, pruebas y suite (rechazado en producción): el «audio» es el texto en UTF-8.
 * Un audio vacío o que empieza por `~` se toma como ininteligible.
 */
export class ScriptedSpeechAdapter implements SpeechToTextPort {
  readonly provider = 'simulado';
  async transcribe(req: SpeechRequest): Promise<SpeechResult> {
    const transcript = req.audio.toString('utf8').trim();
    const intelligible = transcript.length > 0 && !transcript.startsWith('~');
    return {
      transcript: intelligible ? transcript : '',
      intelligible,
      model: 'simulado',
      latencyMs: 0,
    };
  }
}

/** D-010: proveedor de voz a texto; null = sin transcripción (se pide al cliente que escriba). */
export function speechFromConfig(cfg: AppConfig): SpeechToTextPort | null {
  const provider =
    cfg.STT_PROVIDER ??
    (cfg.LLM_PROVIDER === 'simulado' ? 'simulado' : cfg.GEMINI_API_KEY ? 'gemini' : 'ninguno');
  switch (provider) {
    case 'gemini': {
      if (!cfg.GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY');
      const model = cfg.STT_MODEL ?? (cfg.LLM_PROVIDER === 'gemini' ? cfg.LLM_MODEL : undefined);
      return new GeminiSpeechAdapter({
        apiKey: cfg.GEMINI_API_KEY,
        ...(model ? { model } : {}),
        timeoutMs: cfg.STT_TIMEOUT_MS,
      });
    }
    case 'simulado':
      return new ScriptedSpeechAdapter();
    default:
      return null;
  }
}
