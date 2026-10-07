import type { AgentTestJob, AgentTestResult, LlmPort } from '@abaya/domain';
import type { Catalog } from '../catalog/catalog.js';
import { ConversationEngine, type TurnKnowledge } from '../engine/conversation-engine.js';
import type { Profile } from '../engine/types.js';

export interface AgentTestDeps {
  llm: LlmPort;
  catalog: Catalog;
  /** v1.9: documentos publicados de los Brains del agente. */
  knowledge?: TurnKnowledge;
  timeoutMs?: number;
}

const EVENT_LABEL: Record<string, string> = {
  TRANSFER_BACKOFFICE: 'Transferencia al backoffice (con nota interna)',
  ESCALATE: 'Escalado a un asesor humano',
  RECORD_CONSENT: 'Consentimiento registrado (evidencia con cadena de hashes)',
};

/**
 * "Probar agente" (v1.8): corre UN turno del motor real (máquina de estados, catálogo,
 * plantillas y validadores) con la configuración indicada. No toca Abaya, no guarda nada y no
 * registra el contenido: el panel conserva el estado de la conversación simulada.
 */
export async function runAgentTest(d: AgentTestDeps, job: AgentTestJob): Promise<AgentTestResult> {
  const engine = new ConversationEngine({
    llm: d.llm,
    catalog: d.catalog,
    agentConfig: () => job.agent,
    ...(d.knowledge ? { knowledge: d.knowledge } : {}),
    ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
  });
  const r = await engine.runTurn(
    {
      conversationId: 'prueba-panel',
      stage: job.state.stage,
      profile: job.state.profile as Profile,
      history: job.state.history.slice(-20),
    },
    [job.message],
  );
  const replies: string[] = [];
  const events: string[] = [];
  for (const a of r.actions) {
    if (a.type === 'SEND') replies.push(a.text);
    else if (a.type === 'CLOSE')
      events.push(
        a.reason === 'SUPPORT' ? 'Chat cerrado (soporte *611)' : 'Chat cerrado sin venta',
      );
    else if (a.type === 'NEEDS_REVIEW') events.push(`Pasaría a revisión humana: ${a.reason}`);
    else events.push(EVENT_LABEL[a.type] ?? a.type);
  }
  return {
    stage: r.stage,
    profile: Object.fromEntries(
      Object.entries(r.profile).filter((e): e is [string, string] => typeof e[1] === 'string'),
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
  };
}
