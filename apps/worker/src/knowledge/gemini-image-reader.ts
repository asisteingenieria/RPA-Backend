import type { AppConfig } from '@abaya/config';
import type { UsageRecorder } from '@abaya/domain';
import { ImageReadError, type PlanImageCard, type PlanImageReader } from '@abaya/knowledge';
import { DEFAULT_GEMINI_MODEL } from '../llm/adapters/gemini.adapter.js';

export interface GeminiImageReaderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  baseURL?: string;
  fetchImpl?: typeof fetch;
  /** Consumo de tokens de cada lectura (vista «Consumo»). */
  usage?: UsageRecorder;
}

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Solo transcribe lo impreso: la comparación con el catálogo la hace el código. */
const INSTRUCTION = [
  'La imagen muestra tarjetas de planes de telefonía móvil.',
  'Devuelve una entrada por cada tarjeta, en el orden en que aparecen (izquierda a derecha,',
  'arriba a abajo), con lo que está IMPRESO, sin inferir ni corregir nada:',
  '- code: el número al inicio del encabezado de la tarjeta (p. ej. 38327), o null si no hay.',
  '- dataText: los datos principales tal cual (p. ej. "65 GB" o "GB ILIMITADAS"); no los GB',
  '  "para compartir" ni otros extras.',
  '- priceCop: el precio mensual en pesos como entero (p. ej. "$ 56.900" → 56900).',
  '- sharedDataText: los GB "para compartir" tal cual (p. ej. "70 GB para compartir"), o null.',
  '- includesText: lo que aparece bajo "INCLUYE", con los nombres de los servicios y logos en',
  '  texto, unidos con " + " (p. ej. "Claro video + Prime video + Claro club + Claro drive +',
  '  Claro música"), o null.',
  '- unlimitedAppsText: las apps que se pueden seguir usando al acabarse los datos, con sus',
  '  nombres según los logos (p. ej. "X, WhatsApp y Facebook al agotar los datos del plan"), o null.',
  '- callsText: el texto de minutos y SMS tal cual (p. ej. "Minutos y SMS ilimitados nacional +',
  '  LDI USA, Canadá, México y Puerto Rico"), o null.',
  'Si no hay tarjetas de planes, devuelve una lista vacía.',
].join('\n');

const nullableString = { type: ['string', 'null'] };
const SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: nullableString,
          dataText: { type: 'string' },
          priceCop: { type: 'integer' },
          sharedDataText: nullableString,
          includesText: nullableString,
          unlimitedAppsText: nullableString,
          callsText: nullableString,
        },
        required: [
          'code',
          'dataText',
          'priceCop',
          'sharedDataText',
          'includesText',
          'unlimitedAppsText',
          'callsText',
        ],
      },
    },
  },
  required: ['cards'],
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
 * D-011: lee los planes de una imagen con Gemini (misma clave que el modelo de chat, D-006).
 * Lo leído se valida después contra el catálogo: si lee mal, la versión no se publica.
 */
export class GeminiImageReader implements PlanImageReader {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiImageReaderOptions) {
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async read(bytes: Uint8Array, mime: string): Promise<PlanImageCard[]> {
    const started = Date.now();
    const body = JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: INSTRUCTION },
            { inlineData: { mimeType: mime, data: Buffer.from(bytes).toString('base64') } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4_000,
        responseMimeType: 'application/json',
        responseJsonSchema: SCHEMA,
        ...(this.model.startsWith('gemini-2') ? {} : { thinkingConfig: { thinkingLevel: 'low' } }),
      },
    });
    const res = await this.call(body);
    this.opts.usage?.record({
      kind: 'IMAGE_READ',
      provider: 'gemini',
      model: res.modelVersion ?? this.model,
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens:
        (res.usageMetadata?.candidatesTokenCount ?? 0) +
        (res.usageMetadata?.thoughtsTokenCount ?? 0),
      latencyMs: Date.now() - started,
    });
    if (res.promptFeedback?.blockReason) {
      throw new ImageReadError(
        `bloqueada por el proveedor (${res.promptFeedback.blockReason})`,
        false,
      );
    }
    const candidate = res.candidates?.[0];
    if (!candidate || candidate.finishReason !== 'STOP') {
      throw new ImageReadError(
        `respuesta incompleta (${candidate?.finishReason ?? 'vacía'})`,
        false,
      );
    }
    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    let out: { cards?: unknown };
    try {
      out = JSON.parse(text) as typeof out;
    } catch {
      throw new ImageReadError('la respuesta no es JSON', false);
    }
    return toCards(out.cards);
  }

  private async call(body: string): Promise<GeminiResponse> {
    const url = `${this.opts.baseURL ?? BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`;
    let last: ImageReadError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'x-goog-api-key': this.opts.apiKey, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch {
        last = new ImageReadError('el proveedor no respondió', true);
        continue;
      }
      if (res.ok) return (await res.json()) as GeminiResponse;
      const retryable = res.status === 429 || res.status >= 500;
      // 400: imagen que el proveedor no acepta → error de contenido (no se reintenta).
      last = new ImageReadError(`el proveedor respondió ${res.status}`, retryable);
      if (!retryable) throw last;
    }
    throw last!;
  }
}

/** Valida y limpia lo que devolvió el modelo (nunca se confía en su forma). */
export function toCards(raw: unknown): PlanImageCard[] {
  if (!Array.isArray(raw))
    throw new ImageReadError('la respuesta no trae la lista de planes', false);
  const cards: PlanImageCard[] = [];
  for (const c of raw.slice(0, 20)) {
    const x = (c ?? {}) as Record<string, unknown>;
    const dataText = typeof x.dataText === 'string' ? x.dataText.trim().slice(0, 40) : '';
    const priceCop = typeof x.priceCop === 'number' ? Math.round(x.priceCop) : NaN;
    const code =
      typeof x.code === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(x.code.trim())
        ? x.code.trim()
        : null;
    if (!dataText || !Number.isFinite(priceCop) || priceCop <= 0) continue;
    // D-014: el resto de la tarjeta (textos cortos; vacío → null).
    const text = (k: string, max: number) =>
      typeof x[k] === 'string' && (x[k] as string).trim()
        ? (x[k] as string).replace(/\s+/g, ' ').trim().slice(0, max)
        : null;
    cards.push({
      code,
      dataText,
      priceCop,
      sharedDataText: text('sharedDataText', 60),
      includesText: text('includesText', 200),
      unlimitedAppsText: text('unlimitedAppsText', 160),
      callsText: text('callsText', 160),
    });
  }
  return cards;
}

/** D-011: lector de imágenes; sin GEMINI_API_KEY no se pueden cargar imágenes de planes. */
export function imageReaderFromConfig(
  cfg: AppConfig,
  usage?: UsageRecorder,
): PlanImageReader | null {
  if (!cfg.GEMINI_API_KEY) return null;
  const model =
    cfg.IMAGE_READER_MODEL ?? (cfg.LLM_PROVIDER === 'gemini' ? cfg.LLM_MODEL : undefined);
  return new GeminiImageReader({
    apiKey: cfg.GEMINI_API_KEY,
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  });
}
