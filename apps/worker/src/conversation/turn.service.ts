import { randomUUID } from 'node:crypto';
import type { AlertPort, ConversationStatus, Stage } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import type { Catalog } from '../catalog/catalog.js';
import type { ConversationEngine } from '../engine/conversation-engine.js';
import { buildSaleSummary } from '../sales/sales.service.js';
import {
  OUTBOUND_IDS_PLACEHOLDER,
  type ConversationStore,
  type OutboxEventInput,
  type TurnCommit,
} from './conversation.store.js';

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
    },
  ) {}

  async handle(conversationId: string): Promise<void> {
    const input = await this.d.store.loadForTurn(conversationId, this.d.historyLimit ?? 10);
    if (!input || !input.pending.length) return;
    if (!ACTIVE_STATUSES.has(input.status)) {
      this.d.logger.info(
        { conversationId, status: input.status },
        'conversación no activa: sin turno',
      );
      return;
    }

    const result = await this.d.engine.runTurn(
      input.state,
      input.pending.map((p) => p.text),
    );
    const now = this.d.now?.() ?? new Date();

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
              afterMessageIds: OUTBOUND_IDS_PLACEHOLDER,
            },
          });
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
