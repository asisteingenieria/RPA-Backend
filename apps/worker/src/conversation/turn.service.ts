import { randomUUID } from 'node:crypto';
import {
  AUDIO_PLACEHOLDER,
  LlmProviderError,
  type AlertPort,
  type ConversationStatus,
  type SpeechToTextPort,
  type Stage,
} from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import type { Catalog } from '../catalog/catalog.js';
import type { ConversationEngine } from '../engine/conversation-engine.js';
import { asVoice } from '../engine/voice.js';
import { buildSaleSummary } from '../sales/sales.service.js';
import {
  OUTBOUND_IDS_PLACEHOLDER,
  type ConversationStore,
  type OutboxEventInput,
  type PendingInbound,
  type TranscriptResult,
  type TurnCommit,
  type TurnInput,
} from './conversation.store.js';
import type { RobotsPause } from './robots-pause.js';

const ACTIVE_STATUSES: ReadonlySet<ConversationStatus> = new Set(['ACTIVE', 'WAITING_CONSENT']);

/**
 * Un turno completo: cargar la ráfaga → motor → traducir acciones a estado, mensajes,
 * venta y eventos → guardar todo en una transacción. El envío real lo hace el rpa al
 * consumir los eventos publicados por el outbox.
 */
export class TurnService {
  constructor(
    private readonly d: {
      store: ConversationStore;
      engine: ConversationEngine;
      catalog: Catalog;
      alerts: AlertPort;
      logger: Logger;
      historyLimit?: number;
      now?: () => Date;
      /** D-004: versión publicada del agente; fija la versión de las conversaciones nuevas. */
      currentAgentVersionId?: () => string;
      /**
       * 13/10/2026: volver a mirar la conversación dentro de `ms` (el robot espera en silencio a que
       * el cliente termine de mandar sus datos). Si se pierde (reinicio), el aviso de espera de
       * D-009 la vuelve a programar: los mensajes siguen pendientes.
       */
      later?: (conversationId: string, ms: number) => void;
      /** D-009: apagado de emergencia (pausados no se llama al modelo) y pausa automática. */
      pause?: RobotsPause;
      /** D-010: voz a texto de las notas de voz; sin proveedor se pide al cliente que escriba. */
      speech?: SpeechToTextPort | null;
      speechTimeoutMs?: number;
      /** Notas de voz más largas no se transcriben (STT_MAX_SECONDS). */
      maxVoiceSeconds?: number;
    },
  ) {}

  async handle(conversationId: string): Promise<void> {
    const input = await this.d.store.loadForTurn(conversationId, this.d.historyLimit ?? 10);
    if (!input) return;
    // D-017: caso recién asignado sin mensajes por responder: el robot abre con el saludo.
    if (!input.pending.length) return this.open(input);
    if (!ACTIVE_STATUSES.has(input.status)) {
      this.d.logger.info(
        { conversationId, status: input.status },
        'conversación no activa: sin turno',
      );
      return;
    }
    // D-009: con los robots pausados los mensajes esperan; al reanudar se retoman.
    if (await this.d.pause?.isPaused()) return;

    // D-010: las notas de voz se transcriben antes del motor. El turno espera la transcripción
    // (la ráfaga no se responde a medias). Si el servicio no responde: como D-009.
    const speechOutage = await this.transcribePending(input.pending);
    if (speechOutage) {
      await this.d.pause?.pauseAll('LLM_OUTAGE', speechOutage);
      await this.d.alerts.raise('LLM_OUTAGE', 'CRITICA', { conversationId, reason: speechOutage });
      this.d.logger.error(
        { conversationId, reason: speechOutage },
        'voz a texto sin respuesta: robots pausados',
      );
      return;
    }
    const customerTexts: string[] = [];
    let voiceUnreadable = false;
    for (const p of input.pending) {
      // Nota de voz que el robot no pudo descargar: se pide escribir, igual que una ilegible.
      if (!p.voice && p.text.trim() === AUDIO_PLACEHOLDER) voiceUnreadable = true;
      else if (!p.voice) customerTexts.push(p.text);
      else if (p.voice.status === 'OK' && p.text.trim()) customerTexts.push(asVoice(p.text));
      else voiceUnreadable = true;
    }
    if (!customerTexts.length) {
      // Solo notas de voz que no se entendieron: se le pide escribir, sin llamar al modelo.
      await this.commitVoiceUnreadable(input);
      return;
    }

    // D-004: una conversación termina con la versión del agente con la que empezó.
    const agentVersionId = input.state.agentVersionId ?? this.d.currentAgentVersionId?.();
    const turnState = agentVersionId ? { ...input.state, agentVersionId } : input.state;
    // 13/10/2026: mientras el cliente manda sus datos tras el «SÍ», el robot no responde: los
    // mensajes quedan pendientes y se revisan juntos cuando deja de escribir.
    const lastAt = new Date(Math.max(...input.pending.map((p) => p.detectedAt.getTime())));
    const waitMs = await this.d.engine.dataWaitMs(
      turnState,
      customerTexts,
      lastAt,
      this.d.now?.() ?? new Date(),
    );
    if (waitMs > 0) {
      this.d.later?.(conversationId, waitMs);
      return;
    }
    const result = await this.d.engine.runTurn(turnState, customerTexts);
    const now = this.d.now?.() ?? new Date();

    const outage = result.actions.find((a) => a.type === 'LLM_OUTAGE');
    if (outage) {
      // D-009: el proveedor no responde (casi siempre cuota o tokens). Nada se marca como
      // atendido ni se envía: se pausan TODOS los robots y un ADMIN revisa y reanuda.
      await this.d.store.commitTurn({
        conversationId,
        stage: input.state.stage,
        profile: input.state.profile,
        status: input.status,
        processedMessageIds: [],
        outbound: [],
        llmCalls: result.llmCalls,
        knowledge: [],
        events: [],
      });
      await this.d.pause?.pauseAll('LLM_OUTAGE', outage.reason);
      await this.d.alerts.raise('LLM_OUTAGE', 'CRITICA', { conversationId, reason: outage.reason });
      this.d.logger.error(
        { conversationId, reason: outage.reason },
        'LLM sin respuesta: robots pausados',
      );
      return;
    }

    const commit: TurnCommit = {
      conversationId,
      stage: result.stage,
      profile: result.profile,
      status: statusFor(result.stage),
      processedMessageIds: input.pending.map((p) => p.id),
      outbound: [],
      respondsToAt: new Date(Math.min(...input.pending.map((p) => p.detectedAt.getTime()))),
      llmCalls: result.llmCalls,
      knowledge: result.knowledge ?? [],
      events: [],
      ...(agentVersionId ? { agentVersionId } : {}),
    };
    if (result.catalogEmpty) {
      // El catálogo publicado no tiene planes para el proceso: se escaló sin ofrecer nada.
      await this.d.alerts.raise('CATALOG_EMPTY_FOR_PROCESS', 'ALTA', {
        conversationId,
        process: result.catalogEmpty,
      });
    }
    const replyEvents: OutboxEventInput[] = [];

    for (const a of result.actions) {
      switch (a.type) {
        case 'SEND':
          commit.outbound.push({ text: a.text, idempotencyKey: randomUUID() });
          break;
        case 'SEND_IMAGE':
          // D-014 fase 2: el robot pega la imagen en Abaya con su pie de foto (un mensaje). Solo
          // llega aquí si el motor ofrece con imágenes (SEND_PLAN_IMAGES).
          commit.outbound.push({
            text: a.caption ?? '',
            idempotencyKey: randomUUID(),
            imageId: a.image.imageId,
          });
          break;
        case 'RECORD_CONSENT': {
          commit.consent = {
            textShownHash: a.textShownHash,
            templateVersion: a.templateVersion,
            customerReply: a.customerReply,
            acceptedAt: now,
          };
          const p = result.profile;
          if (p.process && p.planCode) {
            commit.sale = {
              process: p.process,
              planCode: p.planCode,
              ...(p.planCatalogVersionId ? { catalogVersionId: p.planCatalogVersionId } : {}),
              summary: buildSaleSummary({
                conversationId,
                abayaChatId: input.abayaChatId,
                profile: p,
                plan: await this.d.catalog.get(p.planCode),
                consentAt: now,
              }),
            };
            commit.events.push({
              type: 'SaleCompleted',
              payload: { conversationId, planCode: p.planCode },
            });
          } else {
            // No debería ocurrir: autorización sin plan. Mejor que lo revise un humano.
            commit.status = 'NEEDS_REVIEW';
          }
          break;
        }
        case 'TRANSFER_BACKOFFICE':
          commit.events.push(transferEvent(conversationId, input.abayaChatId, 'BACKOFFICE'));
          // 13/10/2026: los datos que dio el cliente tras el «SÍ» quedan en el resumen de la venta.
          if (a.serviceCase) {
            // D-023: no hay venta: el resumen va en un caso de servicio que el backoffice recibe.
            commit.serviceCase = {
              kind: a.serviceCase,
              summary: serviceCaseSummary(a.serviceCase, a.saleDataNote),
            };
          } else if (a.saleDataNote) commit.saleDataNote = a.saleDataNote;
          break;
        case 'ESCALATE':
          commit.events.push(transferEvent(conversationId, input.abayaChatId, 'HUMAN'));
          break;
        case 'CLOSE':
          commit.events.push({
            type: 'ConversationClosed',
            payload: {
              conversationId,
              abayaChatId: input.abayaChatId,
              reason: a.reason,
              // D-025: la tipificación que eligió el modelo según la conversación (si hay).
              ...(result.profile.closeTag ? { tag: result.profile.closeTag } : {}),
              afterMessageIds: OUTBOUND_IDS_PLACEHOLDER,
            },
          });
          break;
        case 'ALERT':
          // D-018: amenaza del cliente: aviso a supervisores (sin datos personales ni el texto).
          await this.d.alerts.raise(a.code, 'ALTA', { conversationId });
          break;
        case 'NEEDS_REVIEW':
          commit.status = 'NEEDS_REVIEW';
          // Los entrantes quedan sin procesar para atenderlos cuando se resuelva.
          commit.processedMessageIds = [];
          commit.events.push({
            type: 'NeedsReview',
            payload: { conversationId, reason: a.reason },
          });
          await this.d.alerts.raise('CONVERSATION_NEEDS_REVIEW', 'ALTA', {
            conversationId,
            reason: a.reason,
          });
          break;
      }
    }

    // D-010: si además hubo una nota de voz que no se entendió y la conversación sigue, se dice.
    if (voiceUnreadable && (commit.status === 'ACTIVE' || commit.status === 'WAITING_CONSENT')) {
      commit.outbound.push({
        text: await this.d.engine.systemText(turnState, 'NOTA_DE_VOZ_ILEGIBLE'),
        idempotencyKey: randomUUID(),
      });
    }

    // Un ReplyReady por mensaje, ANTES de transferencias o cierres (orden del outbox).
    commit.outbound.forEach((_, i) =>
      replyEvents.push({
        type: 'ReplyReady',
        payload: { conversationId, abayaChatId: input.abayaChatId, outboundIndex: i },
      }),
    );
    commit.events = [...replyEvents, ...commit.events].map((e) => ({
      ...e,
      payload: { ...e.payload, robotUser: input.robotUser },
    }));

    await this.d.store.commitTurn(commit);
    this.d.logger.info(
      {
        conversationId,
        stage: result.stage,
        validation: result.validationResult,
        replies: commit.outbound.length,
      },
      'turno procesado',
    );
  }

  private transcribePending(pending: PendingInbound[]): Promise<string | null> {
    return transcribeVoiceNotes(
      {
        store: this.d.store,
        speech: this.d.speech ?? null,
        logger: this.d.logger,
        ...(this.d.speechTimeoutMs ? { speechTimeoutMs: this.d.speechTimeoutMs } : {}),
        ...(this.d.maxVoiceSeconds ? { maxVoiceSeconds: this.d.maxVoiceSeconds } : {}),
      },
      pending,
    );
  }

  /**
   * D-017: apertura del caso, como la asesora: saludo con el menú sin esperar al cliente. Solo si
   * la conversación está activa, en el menú y el robot no ha hablado (no se reabre un caso).
   */
  private async open(input: TurnInput) {
    if (input.status !== 'ACTIVE' || input.state.stage !== 'MENU') return;
    if (await this.d.pause?.isPaused()) return; // se abre cuando el cliente escriba o al reanudar
    const agentVersionId = input.state.agentVersionId ?? this.d.currentAgentVersionId?.();
    const text = await this.d.engine.opening(
      agentVersionId ? { ...input.state, agentVersionId } : input.state,
    );
    if (!text) return;
    await this.d.store.commitTurn({
      conversationId: input.state.conversationId,
      stage: input.state.stage,
      profile: input.state.profile,
      status: input.status,
      ...(agentVersionId ? { agentVersionId } : {}),
      processedMessageIds: [],
      outbound: [{ text, idempotencyKey: randomUUID() }],
      respondsToAt: this.d.now?.() ?? new Date(),
      llmCalls: [],
      knowledge: [],
      events: [
        {
          type: 'ReplyReady',
          payload: {
            conversationId: input.state.conversationId,
            abayaChatId: input.abayaChatId,
            outboundIndex: 0,
            robotUser: input.robotUser,
          },
        },
      ],
    });
    this.d.logger.info(
      { conversationId: input.state.conversationId },
      'caso abierto con el saludo',
    );
  }

  /** D-010: la ráfaga fue solo de notas de voz que no se entendieron: se pide escribirlas. */
  private async commitVoiceUnreadable(input: TurnInput) {
    // D-015: plantilla NOTA_DE_VOZ_ILEGIBLE de la versión del agente de la conversación.
    const agentVersionId = input.state.agentVersionId ?? this.d.currentAgentVersionId?.();
    const unreadable = await this.d.engine.systemText(
      agentVersionId ? { ...input.state, agentVersionId } : input.state,
      'NOTA_DE_VOZ_ILEGIBLE',
    );
    await this.d.store.commitTurn({
      conversationId: input.state.conversationId,
      stage: input.state.stage,
      profile: input.state.profile,
      status: input.status,
      processedMessageIds: input.pending.map((p) => p.id),
      outbound: [{ text: unreadable, idempotencyKey: randomUUID() }],
      respondsToAt: new Date(Math.min(...input.pending.map((p) => p.detectedAt.getTime()))),
      llmCalls: [],
      knowledge: [],
      events: [
        {
          type: 'ReplyReady',
          payload: {
            conversationId: input.state.conversationId,
            abayaChatId: input.abayaChatId,
            outboundIndex: 0,
            robotUser: input.robotUser,
          },
        },
      ],
    });
    this.d.logger.info(
      { conversationId: input.state.conversationId },
      'nota de voz sin transcribir: se pidió escribir',
    );
  }
}

// ---------- D-010: notas de voz ----------

export interface VoiceTurnDeps {
  store: ConversationStore;
  speech?: SpeechToTextPort | null;
  speechTimeoutMs?: number;
  maxVoiceSeconds?: number;
  logger: Logger;
}

/**
 * Transcribe las notas de voz PENDING de la ráfaga, guarda cada resultado (y borra el audio) y
 * deja el texto en `pending`. Devuelve el motivo si el servicio no responde (`outage`, D-009):
 * en ese caso nada se guarda y la nota sigue PENDING para cuando se reanude.
 */
export async function transcribeVoiceNotes(
  d: VoiceTurnDeps,
  pending: PendingInbound[],
): Promise<string | null> {
  for (const p of pending) {
    if (p.voice?.status !== 'PENDING') continue;
    const r = await transcribeOne(d, p);
    if ('outage' in r) return r.outage;
    await d.store.saveTranscript(p.id, r);
    p.text = r.text;
    p.voice = { ...p.voice, status: r.status };
  }
  return null;
}

async function transcribeOne(
  d: VoiceTurnDeps,
  p: PendingInbound,
): Promise<TranscriptResult | { outage: string }> {
  const failed: TranscriptResult = { status: 'FAILED', text: '', model: null, ms: null };
  if (!d.speech) return failed;
  const duration = p.voice?.durationSec ?? null;
  if (duration !== null && duration > (d.maxVoiceSeconds ?? 120)) {
    return { ...failed, status: 'TOO_LONG' };
  }
  const audio = await d.store.voiceAudio(p.id);
  if (!audio) return failed;
  try {
    const r = await d.speech.transcribe({
      audio: audio.data,
      mimeType: audio.mimeType,
      ...(d.speechTimeoutMs ? { timeoutMs: d.speechTimeoutMs } : {}),
    });
    return r.intelligible
      ? { status: 'OK', text: r.transcript, model: r.model, ms: r.latencyMs }
      : { status: 'UNINTELLIGIBLE', text: '', model: r.model, ms: r.latencyMs };
  } catch (err) {
    if (err instanceof LlmProviderError && err.outage) return { outage: err.message };
    // Falló solo esta nota (formato, contenido bloqueado): sin contenido en el log (regla 6).
    d.logger.warn(
      { messageId: p.id, err: err instanceof Error ? err.message : 'error' },
      'nota de voz sin transcribir',
    );
    return failed;
  }
}

/** D-023: resumen del caso de servicio para el backoffice (sin datos en logs: va cifrado). */
function serviceCaseSummary(kind: 'VALIDACION_PORTABILIDAD', data?: string): string {
  const head =
    kind === 'VALIDACION_PORTABILIDAD'
      ? 'Validación de portabilidad: el cliente ya solicitó una portabilidad y no recibió la confirmación de su solicitud.'
      : kind;
  return data
    ? `${head}
${data}`
    : head;
}

function transferEvent(
  conversationId: string,
  abayaChatId: string,
  target: 'BACKOFFICE' | 'HUMAN',
): OutboxEventInput {
  return {
    type: 'TransferRequested',
    payload: { conversationId, abayaChatId, target, afterMessageIds: OUTBOUND_IDS_PLACEHOLDER },
  };
}

export function statusFor(stage: Stage): ConversationStatus {
  switch (stage) {
    case 'AUTORIZACION':
      return 'WAITING_CONSENT';
    case 'TRANSFERENCIA':
    case 'ESCALAR':
      return 'TRANSFERRING';
    case 'SOPORTE':
      return 'CLOSED_SUPPORT';
    case 'CIERRE_SIN_VENTA':
      return 'CLOSED_NO_SALE';
    default:
      return 'ACTIVE';
  }
}
