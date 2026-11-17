import type {
  ImageDescriberPort,
  LlmPort,
  SpeechToTextPort,
  UsageKind,
  UsageRecorder,
} from '@abaya/domain';

/**
 * Vista «Consumo»: registra los tokens de cada llamada sin cambiar lo que devuelve. Las
 * conversaciones reales no se envuelven (su consumo ya queda en `LlmCall`); sí la suite de
 * evaluación y «Probar agente».
 */
export function meteredLlm(llm: LlmPort, usage: UsageRecorder, kind: UsageKind): LlmPort {
  return {
    provider: llm.provider,
    async complete(req) {
      const res = await llm.complete(req);
      usage.record({
        kind,
        provider: res.provider ?? llm.provider,
        model: res.model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        latencyMs: res.latencyMs,
      });
      return res;
    },
  };
}

/** Voz a texto: notas de voz reales (`VOICE`) o de prueba (`TEST`). */
export function meteredSpeech(
  speech: SpeechToTextPort | null,
  usage: UsageRecorder,
  kind: UsageKind,
): SpeechToTextPort | null {
  if (!speech) return null;
  return {
    provider: speech.provider,
    async transcribe(req) {
      const r = await speech.transcribe(req);
      usage.record({
        kind,
        provider: speech.provider,
        model: r.model,
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        latencyMs: r.latencyMs,
      });
      return r;
    },
  };
}

/** D-047: descripción de imágenes del cliente (`INBOUND_IMAGE`) o de prueba (`TEST`). */
export function meteredVision(
  vision: ImageDescriberPort | null,
  usage: UsageRecorder,
  kind: UsageKind,
): ImageDescriberPort | null {
  if (!vision) return null;
  return {
    provider: vision.provider,
    async describe(req) {
      const r = await vision.describe(req);
      usage.record({
        kind,
        provider: vision.provider,
        model: r.model,
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        latencyMs: r.latencyMs,
      });
      return r;
    },
  };
}
