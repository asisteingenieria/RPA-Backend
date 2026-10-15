import type { ConversationStatus, Stage, TranscriptStatus } from '@abaya/domain';
import type { ChatTurnMessage, LlmCallRecord, Profile } from '../engine/types.js';
import { asVoice } from '../engine/voice.js';
import {
  OUTBOUND_IDS_PLACEHOLDER,
  type ConversationStore,
  type TranscriptResult,
  type TurnCommit,
  type TurnInput,
} from './conversation.store.js';

interface MemMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  text: string;
  processed: boolean;
  idempotencyKey?: string;
  /** D-014 fase 2: imagen de planes que acompaña al saliente. */
  imageId?: string;
  at: Date;
  respondsToAt?: Date;
  /** D-010: nota de voz; `audio` se borra al transcribir. */
  voice?: { status: TranscriptStatus; durationSec: number | null; audio: Buffer | null };
}

interface MemConversation {
  id: string;
  abayaChatId: string;
  robotUser: string;
  stage: Stage;
  profile: Profile;
  status: ConversationStatus;
  messages: MemMessage[];
  agentVersionId?: string;
}

/** Store en memoria para pruebas y para la suite de evaluación. */
export class MemoryConversationStore implements ConversationStore {
  readonly conversations = new Map<string, MemConversation>();
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  readonly llmCalls: LlmCallRecord[] = [];
  readonly sales: NonNullable<TurnCommit['sale']>[] = [];
  /** D-023: casos de servicio que pasan al backoffice sin ser una venta. */
  readonly serviceCases: NonNullable<TurnCommit['serviceCase']>[] = [];
  readonly knowledge: NonNullable<TurnCommit['knowledge']> = [];
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

  /** D-010: nota de voz; `audio` null = el robot no la pudo descargar. */
  addVoice(conversationId: string, audio: Buffer | null, durationSec: number | null = null) {
    const c = this.conversations.get(conversationId)!;
    const id = `in-${++this.seq}`;
    c.messages.push({
      id,
      direction: 'INBOUND',
      text: '',
      processed: false,
      at: new Date(),
      voice: { status: audio ? 'PENDING' : 'FAILED', durationSec, audio },
    });
    return id;
  }

  async voiceAudio(messageId: string) {
    const m = this.message(messageId);
    return m?.voice?.audio ? { data: m.voice.audio, mimeType: 'audio/ogg' } : null;
  }

  async saveTranscript(messageId: string, t: TranscriptResult) {
    const m = this.message(messageId);
    if (!m?.voice || m.voice.status !== 'PENDING') return;
    m.text = t.text;
    m.voice = { ...m.voice, status: t.status, audio: null };
  }

  private message(messageId: string): MemMessage | undefined {
    for (const c of this.conversations.values()) {
      const m = c.messages.find((x) => x.id === messageId);
      if (m) return m;
    }
    return undefined;
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
      .map((m) => ({
        role: m.direction === 'INBOUND' ? 'customer' : 'bot',
        text: m.voice?.status === 'OK' ? asVoice(m.text) : m.text,
      }));
    return {
      state: {
        conversationId,
        stage: c.stage,
        profile: { ...c.profile },
        history,
        ...(c.agentVersionId ? { agentVersionId: c.agentVersionId } : {}),
      },
      abayaChatId: c.abayaChatId,
      robotUser: c.robotUser,
      status: c.status,
      pending: pending.map((m) => ({
        id: m.id,
        text: m.text,
        detectedAt: m.at,
        ...(m.voice ? { voice: { status: m.voice.status, durationSec: m.voice.durationSec } } : {}),
      })),
    };
  }

  async commitTurn(t: TurnCommit) {
    const c = this.conversations.get(t.conversationId)!;
    c.stage = t.stage as Stage;
    c.profile = { ...t.profile };
    c.status = t.status;
    if (t.agentVersionId && !c.agentVersionId) c.agentVersionId = t.agentVersionId;
    for (const m of c.messages) if (t.processedMessageIds.includes(m.id)) m.processed = true;
    const ids = t.outbound.map((o, i) => {
      const id = `out-${++this.seq}`;
      c.messages.push({
        id,
        direction: 'OUTBOUND',
        text: o.text,
        processed: true,
        idempotencyKey: o.idempotencyKey,
        ...(o.imageId ? { imageId: o.imageId } : {}),
        at: new Date(),
        ...(i === 0 && t.respondsToAt ? { respondsToAt: t.respondsToAt } : {}),
      });
      return id;
    });
    this.llmCalls.push(...t.llmCalls);
    if (t.sale) this.sales.push(t.sale);
    if (t.serviceCase) this.serviceCases.push(t.serviceCase);
    if (t.saleDataNote) {
      const sale = this.sales.at(-1);
      if (sale)
        sale.summary = `${sale.summary}
${t.saleDataNote}`;
    }
    this.knowledge.push(...(t.knowledge ?? []));
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
