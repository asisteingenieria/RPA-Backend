import type { ConversationStatus, Stage } from '@abaya/domain';
import type { ChatTurnMessage, LlmCallRecord, Profile } from '../engine/types.js';
import {
  OUTBOUND_IDS_PLACEHOLDER,
  type ConversationStore,
  type TurnCommit,
  type TurnInput,
} from './conversation.store.js';

interface MemMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  text: string;
  processed: boolean;
  idempotencyKey?: string;
  at: Date;
  respondsToAt?: Date;
}

interface MemConversation {
  id: string;
  abayaChatId: string;
  robotUser: string;
  stage: Stage;
  profile: Profile;
  status: ConversationStatus;
  messages: MemMessage[];
}

/** Store en memoria para pruebas y para la suite de evaluación. */
export class MemoryConversationStore implements ConversationStore {
  readonly conversations = new Map<string, MemConversation>();
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  readonly llmCalls: LlmCallRecord[] = [];
  readonly sales: NonNullable<TurnCommit['sale']>[] = [];
  readonly consents: NonNullable<TurnCommit['consent']>[] = [];
  private seq = 0;

  create(id: string, abayaChatId = `CH-${id}`): void {
    this.conversations.set(id, {
      id,
      abayaChatId,
      robotUser: 'robot-ventas-01',
      stage: 'MENU',
      profile: {},
      status: 'ACTIVE',
      messages: [],
    });
  }

  addInbound(conversationId: string, text: string): string {
    const c = this.conversations.get(conversationId)!;
    const id = `in-${++this.seq}`;
    c.messages.push({ id, direction: 'INBOUND', text, processed: false, at: new Date() });
    return id;
  }

  get(conversationId: string): MemConversation {
    return this.conversations.get(conversationId)!;
  }

  outboundTexts(conversationId: string): string[] {
    return this.get(conversationId)
      .messages.filter((m) => m.direction === 'OUTBOUND')
      .map((m) => m.text);
  }

  async loadForTurn(conversationId: string, historyLimit: number): Promise<TurnInput | null> {
    const c = this.conversations.get(conversationId);
    if (!c) return null;
    const pending = c.messages.filter((m) => m.direction === 'INBOUND' && !m.processed);
    const history: ChatTurnMessage[] = c.messages
      .filter((m) => m.direction === 'OUTBOUND' || m.processed)
      .slice(-historyLimit)
      .map((m) => ({ role: m.direction === 'INBOUND' ? 'customer' : 'bot', text: m.text }));
    return {
      state: { conversationId, stage: c.stage, profile: { ...c.profile }, history },
      abayaChatId: c.abayaChatId,
      robotUser: c.robotUser,
      status: c.status,
      pending: pending.map((m) => ({ id: m.id, text: m.text, detectedAt: m.at })),
    };
  }

  async commitTurn(t: TurnCommit) {
    const c = this.conversations.get(t.conversationId)!;
    c.stage = t.stage as Stage;
    c.profile = { ...t.profile };
    c.status = t.status;
    for (const m of c.messages) if (t.processedMessageIds.includes(m.id)) m.processed = true;
    const ids = t.outbound.map((o, i) => {
      const id = `out-${++this.seq}`;
      c.messages.push({
        id,
        direction: 'OUTBOUND',
        text: o.text,
        processed: true,
        idempotencyKey: o.idempotencyKey,
        at: new Date(),
        ...(i === 0 && t.respondsToAt ? { respondsToAt: t.respondsToAt } : {}),
      });
      return id;
    });
    this.llmCalls.push(...t.llmCalls);
    if (t.sale) this.sales.push(t.sale);
    if (t.consent) this.consents.push(t.consent);
    for (const e of t.events)
      this.events.push({ type: e.type, payload: resolvePayload(e.payload, ids) });
    return { outboundMessageIds: ids };
  }
}

/** Resuelve referencias a los mensajes salientes creados en el mismo turno. */
export function resolvePayload(payload: Record<string, unknown>, ids: string[]) {
  const out: Record<string, unknown> = { ...payload };
  if (typeof out.outboundIndex === 'number') {
    out.messageId = ids[out.outboundIndex];
    delete out.outboundIndex;
  }
  if (out.afterMessageIds === OUTBOUND_IDS_PLACEHOLDER) out.afterMessageIds = ids;
  return out;
}
