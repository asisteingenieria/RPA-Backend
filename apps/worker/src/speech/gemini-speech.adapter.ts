import {
  LlmProviderError,
  type SpeechRequest,
  type SpeechResult,
  type SpeechToTextPort,
} from '@abaya/domain';
import { DEFAULT_GEMINI_MODEL } from '../llm/adapters/gemini.adapter.js';

export interface GeminiSpeechOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  baseURL?: string;
  fetchImpl?: typeof fetch;
}

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Solo transcribe: no responde, no resume, no corrige (el motor decide qué hacer con el texto). */
const INSTRUCTION = [
  'Transcribe literalmente la nota de voz de un cliente en español de Colombia.',
  'No respondas, no resumas, no corrijas ni agregues nada: solo lo que dice la persona.',
  'Escribe las cifras como las dice. Si no hay habla clara (silencio, ruido, música o algo',
  'que no se entiende), devuelve intelligible=false y transcript vacío.',
].join(' ');

const SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string' },
    intelligible: { type: 'boolean' },
  },
  required: ['transcript', 'intelligible'],
};

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * D-010: voz a texto con Gemini (`generateContent` con el audio en línea), la misma clave y API
 * que el modelo de chat (D-006). Errores con `LlmProviderError`: `outage` si el servicio no
 * responde (D-009 pausa los robots), si no, falla solo esta nota.
 */
export class GeminiSpeechAdapter implements SpeechToTextPort {
  readonly provider = 'gemini';
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiSpeechOptions) {
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async transcribe(req: SpeechRequest): Promise<SpeechResult> {
    const started = Date.now();
    const body = JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: INSTRUCTION },
            { inlineData: { mimeType: req.mimeType, data: req.audio.toString('base64') } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 2_000,
        responseMimeType: 'application/json',
        responseJsonSchema: SCHEMA,
        ...(this.model.startsWith('gemini-2') ? {} : { thinkingConfig: { thinkingLevel: 'low' } }),
      },
    });
    const res = await this.call(body, req.timeoutMs ?? this.opts.timeoutMs ?? 10_000);
    if (res.promptFeedback?.blockReason) {
      throw new LlmProviderError(
        `gemini bloqueado ${res.promptFeedback.blockReason}`,
        this.provider,
        false,
        false,
      );
    }
    const candidate = res.candidates?.[0];
    if (!candidate || candidate.finishReason !== 'STOP') {
      throw new LlmProviderError(
        `gemini ${candidate?.finishReason ?? 'vacío'}`,
        this.provider,
        false,
        false,
      );
    }
    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    let out: { transcript?: unknown; intelligible?: unknown };
    try {
      out = JSON.parse(text) as typeof out;
    } catch {
      throw new LlmProviderError('gemini transcripción no es JSON', this.provider, false, false);
    }
    const transcript = typeof out.transcript === 'string' ? out.transcript.trim() : '';
    return {
      transcript,
      intelligible: out.intelligible === true && transcript.length > 0,
      model: res.modelVersion ?? this.model,
      latencyMs: Date.now() - started,
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens:
        (res.usageMetadata?.candidatesTokenCount ?? 0) +
        (res.usageMetadata?.thoughtsTokenCount ?? 0),
    };
  }

  /** Una llamada con 1 reintento si el fallo es transitorio (igual que el adaptador de chat). */
  private async call(body: string, timeoutMs: number): Promise<GeminiResponse> {
    const url = `${this.opts.baseURL ?? BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`;
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
      // 400 con un audio corrupto o en un formato que no acepta: falla solo esta nota.
      last = new LlmProviderError(
        `gemini ${res.status}`,
        this.provider,
        retryable,
        res.status !== 400,
      );
      if (!retryable) throw last;
    }
    throw last!;
  }
}
