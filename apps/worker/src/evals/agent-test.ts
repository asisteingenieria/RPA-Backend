import {
  LlmProviderError,
  type AgentTestJob,
  type AgentTestResult,
  type LlmPort,
  type SpeechToTextPort,
} from '@abaya/domain';
import type { Catalog } from '../catalog/catalog.js';
import { ConversationEngine, type TurnKnowledge } from '../engine/conversation-engine.js';
import { systemText } from '../engine/templates/templates.js';
import type { Profile } from '../engine/types.js';
import { asVoice } from '../engine/voice.js';

export interface AgentTestDeps {
  llm: LlmPort;
  catalog: Catalog;
  /** v1.9: documentos publicados de los Brains del agente. */
  knowledge?: TurnKnowledge;
  timeoutMs?: number;
  /** D-010: voz a texto (el mismo proveedor que atiende las notas de voz reales). */
  speech?: SpeechToTextPort | null;
  speechTimeoutMs?: number;
  maxVoiceSeconds?: number;
}

type Heard = NonNullable<AgentTestResult['heard']>;

/** D-010: transcribe la nota de voz de prueba con las mismas reglas que un turno real. */
async function hear(
  d: AgentTestDeps,
  audio: NonNullable<AgentTestJob['audio']>,
): Promise<Heard | { outage: string }> {
  const failed: Heard = { status: 'FAILED', transcript: '', model: null, latencyMs: null };
  if (!d.speech) return failed;
  if (audio.durationSec !== null && audio.durationSec > (d.maxVoiceSeconds ?? 120)) {
    return { ...failed, status: 'TOO_LONG' };
  }
  try {
    const r = await d.speech.transcribe({
      audio: Buffer.from(audio.data, 'base64'),
      mimeType: audio.mimeType,
      ...(d.speechTimeoutMs ? { timeoutMs: d.speechTimeoutMs } : {}),
    });
    return {
      status: r.intelligible ? 'OK' : 'UNINTELLIGIBLE',
      transcript: r.intelligible ? r.transcript : '',
      model: r.model,
      latencyMs: r.latencyMs,
    };
  } catch (err) {
    if (err instanceof LlmProviderError && err.outage) return { outage: err.message };
    return failed;
  }
}

const EVENT_LABEL: Record<string, string> = {
  TRANSFER_BACKOFFICE: 'Finalizar en Abaya: la venta pasa a la cola de backoffice',
  ESCALATE: 'Escalado a un asesor humano',
  RECORD_CONSENT: 'Consentimiento registrado (evidencia con cadena de hashes)',
};

/**
 * "Probar agente" (v1.8): corre UN turno del motor real (máquina de estados, catálogo,
 * plantillas y validadores) con la configuración indicada. No toca Abaya, no guarda nada y no
 * registra el contenido: el panel conserva el estado de la conversación simulada.
 */
export async function runAgentTest(d: AgentTestDeps, job: AgentTestJob): Promise<AgentTestResult> {
  // D-017: como en un caso real, el robot abre la conversación con el saludo y el menú.
  if (job.opening) {
    const text = await new ConversationEngine({
      llm: d.llm,
      catalog: d.catalog,
      agentConfig: () => job.agent,
    }).opening({
      conversationId: 'prueba-panel',
      stage: job.state.stage,
      profile: job.state.profile as Profile,
      history: job.state.history,
    });
    return {
      stage: job.state.stage,
      profile: job.state.profile,
      replies: text ? [text] : [],
      events: [],
      validation: 'NO_LLM',
      llm: [],
    };
  }
  let message = job.message;
  let heard: Heard | undefined;
  if (job.audio) {
    const h = await hear(d, job.audio);
    if ('outage' in h) {
      return {
        stage: job.state.stage,
        profile: job.state.profile,
        replies: [],
        events: [
          `El servicio de voz a texto no respondió: en producción se pausarían los robots (${h.outage})`,
        ],
        validation: 'PROVIDER_ERROR',
        llm: [],
        heard: { status: 'FAILED', transcript: '', model: null, latencyMs: null },
      };
    }
    heard = h;
    if (h.status !== 'OK') {
      // Como en producción: sin texto que entender, se le pide escribir sin llamar al modelo.
      return {
        stage: job.state.stage,
        profile: job.state.profile,
        replies: [systemText(job.agent, 'NOTA_DE_VOZ_ILEGIBLE')],
        events: [],
        validation: 'NO_LLM',
        llm: [],
        heard: h,
        customerText: '',
      };
    }
    message = asVoice(h.transcript);
  }
  const engine = new ConversationEngine({
    llm: d.llm,
    catalog: d.catalog,
    agentConfig: () => job.agent,
    ...(d.knowledge ? { knowledge: d.knowledge } : {}),
    ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
    // D-011: en pausa (08/10/2026) hasta que se confirme si habrá una imagen por plan del
    // catálogo. Mientras tanto la oferta va en texto, igual que en las conversaciones reales.
    sendPlanImages: false,
    // D-014: con catálogo desde imágenes, la oferta va solo con imágenes.
    offerWithImages: true,
  });
  const turnState = {
    conversationId: 'prueba-panel',
    stage: job.state.stage,
    profile: job.state.profile as Profile,
    history: job.state.history.slice(-20),
  };
  // 13/10/2026: tras el «SÍ», mientras el cliente va mandando sus datos el robot no responde
  // (en Abaya, si deja de escribir, revisa y le recuerda solo lo que falta).
  const now = new Date();
  if ((await engine.dataWaitMs(turnState, [message], now, now)) > 0) {
    const waitSeconds = job.agent.flow.saleDataWaitSeconds;
    return {
      stage: job.state.stage,
      profile: engine.absorbSaleData(turnState, [message]) as AgentTestResult['profile'],
      replies: [],
      events: [
        `El robot espera el resto de los datos (en Abaya, si el cliente no escribe en ${waitSeconds} s, le recuerda solo lo que falta)`,
      ],
      validation: 'NO_LLM',
      llm: [],
      ...(heard ? { heard, customerText: message } : {}),
    };
  }
  const r = await engine.runTurn(turnState, [message]);
  const replies: string[] = [];
  const events: string[] = [];
  const images: NonNullable<AgentTestResult['images']> = [];
  for (const a of r.actions) {
    if (a.type === 'SEND') replies.push(a.text);
    else if (a.type === 'SEND_IMAGE')
      images.push({
        afterReply: replies.length,
        brainId: a.image.brainId,
        version: a.image.version,
        imageId: a.image.imageId,
        sourceName: a.image.sourceName,
        caption: a.caption,
        codes: a.image.codes,
      });
    else if (a.type === 'CLOSE')
      events.push(
        a.reason === 'SUPPORT' ? 'Chat cerrado (soporte *611)' : 'Chat cerrado sin venta',
      );
    else if (a.type === 'NEEDS_REVIEW') events.push(`Pasaría a revisión humana: ${a.reason}`);
    else if (a.type === 'ALERT')
      events.push('Alerta a supervisores: el cliente escribió una amenaza (la conversación sigue)');
    else if (a.type === 'LLM_OUTAGE')
      events.push(`El modelo no respondió: en producción se pausarían los robots (${a.reason})`);
    else events.push(EVENT_LABEL[a.type] ?? a.type);
  }
  return {
    stage: r.stage,
    // Texto y marcas del flujo (D-003): la simulación del panel los devuelve en el turno siguiente.
    profile: Object.fromEntries(
      Object.entries(r.profile).filter(
        (e): e is [string, string | boolean] =>
          typeof e[1] === 'string' || typeof e[1] === 'boolean',
      ),
    ),
    replies,
    events,
    validation: r.validationResult,
    llm: r.llmCalls.map((c) => ({
      provider: c.provider,
      model: c.model,
      latencyMs: c.latencyMs,
      validationResult: c.validationResult,
    })),
    ...(heard ? { heard } : {}),
    customerText: message,
    ...(images.length ? { images } : {}),
  };
}
