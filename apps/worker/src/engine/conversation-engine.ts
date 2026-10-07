import {
  LlmProviderError,
  type LlmPort,
  type LlmRequest,
  type LlmResponse,
  type Stage,
} from '@abaya/domain';
import { sha256 } from '@abaya/crypto';
import { scrubText } from '@abaya/logger';
import type { Catalog, Plan } from '../catalog/catalog.js';
import { turnOutputJsonSchema, type TurnOutput } from './output-schema.js';
import { BASE_PROMPT, PROMPT_VERSION, STAGE_PROMPTS } from './prompts/prompts.js';
import {
  OPTION_PROCESS,
  TERMINAL_STAGES,
  missingProfileFields,
  parseMenuOption,
  transition,
} from './state-machine.js';
import * as T from './templates/templates.js';
import type {
  ConversationState,
  LlmCallRecord,
  Profile,
  TurnAction,
  TurnResult,
  ValidationResult,
} from './types.js';
import { validateTurnOutput } from './validators/validators.js';

export interface EngineDeps {
  llm: LlmPort;
  catalog: Catalog;
  now?: () => Date;
  /** Id del PromptVersion activo por estado (para LlmCall). */
  promptVersionId?: (stage: Stage) => string;
  historyLimit?: number;
  timeoutMs?: number;
}

const EXPLICIT_YES =
  /^\s*(s[ií]\s*,?\s*(lo\s+)?autorizo|autorizo|acepto(\s+la\s+autorizaci[oó]n)?)\s*[.!]*\s*$/i;
const EXPLICIT_NO = /^\s*(no|no\s+autorizo|no\s+acepto|no\s+gracias)\s*[.!]*\s*$/i;

const PROFILE_QUESTION_AFTER_MENU =
  '¡Perfecto! 🙌 Para recomendarte el mejor plan, ¿me compartes tu nombre?';
const CONFIRM_AUTHORIZATION =
  'Para continuar necesito tu confirmación expresa. Por favor responde *SÍ AUTORIZO* si estás de acuerdo, o *NO* si prefieres no autorizar.';

/**
 * Motor de conversación (sección 6.3). El código decide QUÉ pasa (máquina de estados,
 * catálogo, plantillas); el modelo solo decide CÓMO decirlo, y su salida se valida antes
 * de usarla (reglas 10–12).
 */
export class ConversationEngine {
  private readonly now: () => Date;

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async runTurn(state: ConversationState, customerMessages: string[]): Promise<TurnResult> {
    const text = customerMessages.join('\n').trim();
    const stage = state.stage;
    const profile = { ...state.profile };

    if (TERMINAL_STAGES.has(stage) || !text) return result(stage, profile, [], [], 'NO_LLM');

    // Primer contacto: el menú es una plantilla fija.
    const botSpoke = state.history.some((m) => m.role === 'bot');
    const menuOption = stage === 'MENU' ? parseMenuOption(text) : undefined;
    if (stage === 'MENU' && !botSpoke && !menuOption) {
      return result('MENU', profile, [{ type: 'SEND', text: T.MENU }], [], 'NO_LLM');
    }

    // Menú: elección clara → decide el código.
    if (menuOption) {
      if (menuOption === 'D') {
        return result(
          'SOPORTE',
          profile,
          [send(T.SUPPORT), { type: 'CLOSE', reason: 'SUPPORT' }],
          [],
          'NO_LLM',
        );
      }
      profile.process = OPTION_PROCESS[menuOption];
      return result('PERFIL', profile, [send(PROFILE_QUESTION_AFTER_MENU)], [], 'NO_LLM');
    }

    // Autorización: el consentimiento lo reconoce el código, nunca el modelo.
    if (stage === 'AUTORIZACION') {
      if (EXPLICIT_YES.test(text)) {
        return result(
          'TRANSFERENCIA',
          profile,
          [
            {
              type: 'RECORD_CONSENT',
              // Hash y versión del texto EXACTO que se mostró (fijados al mostrarlo).
              textShownHash: profile.authorizationTextHash ?? '',
              templateVersion: profile.authorizationTemplateVersion ?? 'desconocida',
              customerReply: text,
            },
            send(T.TRANSFER),
            { type: 'TRANSFER_BACKOFFICE' },
          ],
          [],
          'NO_LLM',
        );
      }
      if (EXPLICIT_NO.test(text)) {
        return result(
          'CIERRE_SIN_VENTA',
          profile,
          [send(T.NO_SALE_GOODBYE), { type: 'CLOSE', reason: 'NO_SALE' }],
          [],
          'NO_LLM',
        );
      }
    }

    // Turno con el modelo.
    const plans = profile.process ? await this.d.catalog.plansFor(profile.process, this.now()) : [];
    const calls: LlmCallRecord[] = [];
    let output: TurnOutput | undefined;
    let validation: ValidationResult = 'OK';
    const request = this.buildRequest(state, profile, plans, text);

    try {
      let res = await this.call(request, stage, calls);
      let check = this.check(res.json, stage, profile, plans);
      if (!check.ok) {
        // Regenerar UNA vez explicando el error (sección 6.3.5).
        validation = 'REGENERATED';
        res = await this.call(
          {
            ...request,
            messages: [
              ...request.messages,
              { role: 'assistant', content: JSON.stringify(res.json) },
              {
                role: 'user',
                content:
                  'SISTEMA: tu respuesta anterior no cumple las reglas: ' +
                  check.errors.join('; ') +
                  '. Genera de nuevo la respuesta al último mensaje del cliente cumpliendo todas las reglas.',
              },
            ],
          },
          stage,
          calls,
        );
        check = this.check(res.json, stage, profile, plans);
        if (!check.ok) validation = 'FALLBACK';
      }
      if (check.ok) output = check.output;
    } catch (err) {
      if (!(err instanceof LlmProviderError)) throw err;
      return result(
        stage,
        profile,
        [{ type: 'NEEDS_REVIEW', reason: `proveedor LLM: ${err.message}` }],
        markCalls(calls, 'FALLBACK'),
        'PROVIDER_ERROR',
      );
    }

    if (!output) {
      // Respuesta segura de plantilla; el estado no cambia.
      return result(
        stage,
        profile,
        [send(T.SAFE_FALLBACK)],
        markCalls(calls, 'FALLBACK'),
        'FALLBACK',
      );
    }

    return {
      ...this.apply(state, profile, plans, output),
      llmCalls: markCalls(calls, validation),
      validationResult: validation,
    };
  }

  // ---------- aplicar la salida validada ----------

  private apply(
    state: ConversationState,
    profile: Profile,
    plans: Plan[],
    out: TurnOutput,
  ): Omit<TurnResult, 'llmCalls' | 'validationResult'> {
    const stage = state.stage;
    const intent = out.intent;
    const merged = mergeProfile(profile, out.extracted);
    if (stage === 'MENU' && out.option && out.option !== 'D')
      merged.process = OPTION_PROCESS[out.option];

    // El modelo no puede dar por autorizado un mensaje ambiguo.
    if (stage === 'AUTORIZACION' && (intent === 'AUTORIZA' || intent === 'NO_AUTORIZA')) {
      return { stage, profile: merged, actions: [send(CONFIRM_AUTHORIZATION)] };
    }

    const accepted = intent === 'ACEPTA_PLAN' ? (out.planCode ?? undefined) : undefined;
    const t = transition({
      stage,
      intent,
      ...(out.option ? { option: out.option } : {}),
      profile: merged,
      ...(accepted ? { acceptedPlanCode: accepted } : {}),
    });
    if (!t.ok) return { stage, profile, actions: [send(T.SAFE_FALLBACK)] };
    const to = t.to;

    // Plantillas de salida de estados terminales: el texto es 100 % fijo.
    switch (to) {
      case 'SOPORTE':
        return {
          stage: to,
          profile: merged,
          actions: [send(T.SUPPORT), { type: 'CLOSE', reason: 'SUPPORT' }],
        };
      case 'CIERRE_SIN_VENTA':
        return {
          stage: to,
          profile: merged,
          actions: [send(T.NO_SALE_GOODBYE), { type: 'CLOSE', reason: 'NO_SALE' }],
        };
      case 'ESCALAR':
        return { stage: to, profile: merged, actions: [send(T.ESCALATE), { type: 'ESCALATE' }] };
    }

    // Texto del modelo con marcadores reemplazados por las fichas oficiales.
    const byCode = new Map(plans.map((p) => [p.code, p]));
    const offered: string[] = [];
    let reply = out.reply.replace(/\{\{OFERTA:([A-Z][A-Z0-9]{0,9})\}\}/g, (_m, code: string) => {
      offered.push(code);
      return T.offer(byCode.get(code)!);
    });
    if (offered.length) merged.offeredPlanCode = offered.at(-1);

    if (to === 'OFERTA' && stage === 'PERFIL' && !offered.length) {
      reply = `${reply}\n\n${T.offerList(plans)}`;
    }
    if (to === 'AUTORIZACION' && stage !== 'AUTORIZACION') {
      // Al ENTRAR a autorización: fijar el plan y mostrar el texto legal una sola vez.
      const shownAt = this.now();
      const legal = T.authorization(shownAt);
      merged.planCode = accepted;
      merged.authorizationShownAt = shownAt.toISOString();
      merged.authorizationTemplateVersion = T.TEMPLATE_VERSION;
      merged.authorizationTextHash = sha256(legal);
      reply = `${reply}\n\n${legal}`;
    }
    return { stage: to, profile: merged, actions: [send(reply.trim())] };
  }

  // ---------- validación completa (6.3.5 + reglas del motor) ----------

  private check(raw: unknown, stage: Stage, profile: Profile, plans: Plan[]) {
    const v = validateTurnOutput(raw, { stage, process: profile.process, availablePlans: plans });
    if (!v.ok) return v;
    const out = v.output;
    const errors: string[] = [];
    const merged = mergeProfile(profile, out.extracted);
    const offersPlan = /\{\{OFERTA:/.test(out.reply);
    if (stage === 'PERFIL' && offersPlan && missingProfileFields(merged).length) {
      errors.push('perfil incompleto: no ofrezcas planes todavía, pide el dato que falta');
    }
    if (stage === 'MENU' && offersPlan)
      errors.push('no ofrezcas planes antes de conocer el proceso');
    return errors.length ? { ok: false as const, errors } : { ok: true as const, output: out };
  }

  // ---------- llamada al modelo ----------

  private async call(req: LlmRequest, stage: Stage, calls: LlmCallRecord[]): Promise<LlmResponse> {
    const res = await this.d.llm.complete(req);
    calls.push({
      stage,
      provider: res.provider ?? this.d.llm.provider,
      model: res.model,
      promptVersionId: this.d.promptVersionId?.(stage) ?? `v${PROMPT_VERSION}:${stage}`,
      latencyMs: res.latencyMs,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      validationResult: 'OK',
    });
    return res;
  }

  private buildRequest(
    state: ConversationState,
    profile: Profile,
    plans: Plan[],
    text: string,
  ): LlmRequest {
    const missing = missingProfileFields(profile).filter((f) => f !== 'process');
    const catalog = plans.length
      ? plans
          .map(
            (p) =>
              `- ${p.code}: ${p.name} | ${p.dataGb} GB | ${p.priceCop} COP/mes | beneficios: ${p.benefits.join('; ') || 'ninguno'}${p.discountText ? ' | tiene un beneficio adicional aprobado' : ''}`,
          )
          .join('\n')
      : '(aún no aplica: el cliente no ha elegido proceso)';
    const dynamic = [
      STAGE_PROMPTS[state.stage] ?? '',
      `Proceso: ${profile.process ?? 'sin elegir'}`,
      `Datos del cliente ya conocidos: ${JSON.stringify({
        name: profile.name ?? null,
        currentOperator: profile.currentOperator ?? null,
        usage: profile.usage ?? null,
        offeredPlanCode: profile.offeredPlanCode ?? null,
      })}`,
      `Datos que faltan: ${missing.length ? missing.join(', ') : 'ninguno'}`,
      `Catálogo disponible (usa SOLO estos códigos; las cifras son para que razones, NUNCA las escribas):\n${catalog}`,
    ].join('\n\n');

    const history = state.history.slice(-(this.d.historyLimit ?? 10));
    while (history[0]?.role === 'bot') history.shift();
    return {
      systemFixed: BASE_PROMPT,
      systemDynamic: dynamic,
      messages: [
        ...history.map((m) => ({
          role: m.role === 'customer' ? ('user' as const) : ('assistant' as const),
          // Minimización (sección 8): teléfonos y documentos no salen hacia el proveedor.
          content: scrubText(m.text),
        })),
        { role: 'user', content: scrubText(text) },
      ],
      schemaName: 'turno_conversacion',
      jsonSchema: turnOutputJsonSchema,
      timeoutMs: this.d.timeoutMs ?? 8_000,
    };
  }
}

// ---------- utilidades ----------

function send(text: string): TurnAction {
  return { type: 'SEND', text };
}

function result(
  stage: Stage,
  profile: Profile,
  actions: TurnAction[],
  llmCalls: LlmCallRecord[],
  validationResult: TurnResult['validationResult'],
): TurnResult {
  return { stage, profile, actions, llmCalls, validationResult };
}

function markCalls(calls: LlmCallRecord[], v: ValidationResult): LlmCallRecord[] {
  return calls.map((c) => ({ ...c, validationResult: v }));
}

function mergeProfile(p: Profile, ex: TurnOutput['extracted']): Profile {
  const clean = (v: string | null) => (v && v.trim() ? v.trim().slice(0, 120) : undefined);
  return {
    ...p,
    ...(clean(ex.name) ? { name: clean(ex.name) } : {}),
    ...(clean(ex.currentOperator) ? { currentOperator: clean(ex.currentOperator) } : {}),
    ...(clean(ex.usage) ? { usage: clean(ex.usage) } : {}),
  };
}
