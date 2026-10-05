import { GENESIS_HASH, chainHash, sha256, type FieldCipher } from '@abaya/crypto';
import type { PrismaClient } from '@abaya/db';
import {
  consentAad,
  inboundAad,
  outboundAad,
  profileAad,
  saleAad,
  type Stage,
} from '@abaya/domain';
import type { ChatTurnMessage, Profile } from '../engine/types.js';
import type { ConversationStore, TurnCommit, TurnInput } from './conversation.store.js';
import { resolvePayload } from './memory.store.js';

/** Store real: PostgreSQL + Prisma, campos sensibles cifrados (sección 8). */
export class PrismaConversationStore implements ConversationStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async loadForTurn(conversationId: string, historyLimit: number): Promise<TurnInput | null> {
    const c = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!c) return null;
    const [pending, recent] = await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId, direction: 'INBOUND', processedAt: null },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.message.findMany({
        where: {
          conversationId,
          OR: [{ direction: 'OUTBOUND' }, { direction: 'INBOUND', processedAt: { not: null } }],
        },
        orderBy: { occurredAt: 'desc' },
        take: historyLimit,
      }),
    ]);
    const history: ChatTurnMessage[] = recent.reverse().map((m) => ({
      role: m.direction === 'INBOUND' ? 'customer' : 'bot',
      text: this.decryptBody(m),
    }));
    const profile: Profile = c.profileEncrypted
      ? (JSON.parse(this.cipher.decryptString(c.profileEncrypted, profileAad(c.id))) as Profile)
      : {};
    return {
      state: { conversationId, stage: c.stage as Stage, profile, history },
      abayaChatId: c.abayaChatId,
      status: c.status,
      pending: pending.map((m) => ({ id: m.id, text: this.decryptBody(m) })),
    };
  }

  async commitTurn(t: TurnCommit) {
    const id = t.conversationId;
    return this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        await tx.conversation.update({
          where: { id },
          data: {
            stage: t.stage,
            status: t.status,
            profileEncrypted: new Uint8Array(
              this.cipher.encrypt(JSON.stringify(t.profile), profileAad(id)),
            ),
          },
        });
        if (t.processedMessageIds.length) {
          await tx.message.updateMany({
            where: { id: { in: t.processedMessageIds } },
            data: { processedAt: now },
          });
        }
        const ids: string[] = [];
        for (const [i, o] of t.outbound.entries()) {
          const m = await tx.message.create({
            data: {
              conversationId: id,
              direction: 'OUTBOUND',
              idempotencyKey: o.idempotencyKey,
              bodyEncrypted: new Uint8Array(
                this.cipher.encrypt(o.text, outboundAad(o.idempotencyKey)),
              ),
              status: 'PENDING',
              // Orden estable entre respuestas del mismo turno.
              occurredAt: new Date(now.getTime() + i),
            },
          });
          ids.push(m.id);
        }
        if (t.llmCalls.length) {
          await tx.llmCall.createMany({
            data: t.llmCalls.map((c) => ({ ...c, conversationId: id })),
          });
        }
        if (t.sale) {
          await tx.sale.create({
            data: {
              conversationId: id,
              process: t.sale.process,
              planCode: t.sale.planCode,
              summaryEncrypted: new Uint8Array(this.cipher.encrypt(t.sale.summary, saleAad(id))),
            },
          });
        }
        if (t.consent) {
          // Append-only con cadena de hashes global.
          const last = await tx.consentEvidence.findFirst({
            orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
            select: { hash: true },
          });
          const prevHash = last?.hash ?? GENESIS_HASH;
          const textShownHash = sha256(t.consent.textShown);
          const replyEnc = this.cipher.encrypt(t.consent.customerReply, consentAad(id));
          const hash = chainHash(prevHash, {
            conversationId: id,
            textShownHash,
            customerReplyHash: sha256(t.consent.customerReply),
            acceptedAt: t.consent.acceptedAt.toISOString(),
          });
          await tx.consentEvidence.create({
            data: {
              conversationId: id,
              textShownHash,
              customerReplyEncrypted: new Uint8Array(replyEnc),
              acceptedAt: t.consent.acceptedAt,
              prevHash,
              hash,
            },
          });
        }
        if (t.events.length) {
          await tx.outboxEvent.createMany({
            data: t.events.map((e, i) => ({
              type: e.type,
              payload: resolvePayload(e.payload, ids) as object,
              createdAt: new Date(now.getTime() + i),
            })),
          });
        }
        return { outboundMessageIds: ids };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private decryptBody(m: {
    direction: string;
    fingerprint: string | null;
    idempotencyKey: string | null;
    bodyEncrypted: Uint8Array;
  }): string {
    const aad =
      m.direction === 'INBOUND'
        ? inboundAad(m.fingerprint ?? '')
        : outboundAad(m.idempotencyKey ?? '');
    return this.cipher.decryptString(m.bodyEncrypted, aad);
  }
}
