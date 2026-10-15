import { GENESIS_HASH, chainHash, sha256, type FieldCipher } from '@abaya/crypto';
import { withSerializableRetry, type PrismaClient } from '@abaya/db';
import {
  audioAad,
  consentAad,
  inboundAad,
  outboundAad,
  profileAad,
  saleAad,
  serviceCaseAad,
  type Stage,
} from '@abaya/domain';
import type { ChatTurnMessage, Profile } from '../engine/types.js';
import { asVoice } from '../engine/voice.js';
import type {
  ConversationStore,
  TranscriptResult,
  TurnCommit,
  TurnInput,
} from './conversation.store.js';
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
      // D-010: el modelo ve que esa parte del historial fue una nota de voz transcrita.
      text:
        m.mediaKind === 'AUDIO' && m.transcriptStatus === 'OK'
          ? asVoice(this.decryptBody(m))
          : this.decryptBody(m),
    }));
    const profile: Profile = c.profileEncrypted
      ? (JSON.parse(this.cipher.decryptString(c.profileEncrypted, profileAad(c.id))) as Profile)
      : {};
    return {
      state: {
        conversationId,
        stage: c.stage as Stage,
        profile,
        history,
        ...(c.agentVersionId ? { agentVersionId: c.agentVersionId } : {}),
      },
      abayaChatId: c.abayaChatId,
      robotUser: c.robotUser,
      status: c.status,
      pending: pending.map((m) => ({
        id: m.id,
        text: this.decryptBody(m),
        detectedAt: m.createdAt,
        ...(m.mediaKind === 'AUDIO'
          ? {
              voice: {
                status: m.transcriptStatus ?? 'FAILED',
                durationSec: m.mediaDurationSec,
              },
            }
          : {}),
      })),
    };
  }

  async voiceAudio(messageId: string) {
    const m = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { fingerprint: true, mediaEncrypted: true, mediaMimeType: true },
    });
    if (!m?.mediaEncrypted || !m.mediaMimeType) return null;
    return {
      data: this.cipher.decrypt(m.mediaEncrypted, audioAad(m.fingerprint ?? '')),
      mimeType: m.mediaMimeType,
    };
  }

  async saveTranscript(messageId: string, t: TranscriptResult) {
    const m = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { fingerprint: true },
    });
    if (!m) return;
    await this.prisma.message.updateMany({
      where: { id: messageId, transcriptStatus: 'PENDING' },
      data: {
        bodyEncrypted: new Uint8Array(this.cipher.encrypt(t.text, inboundAad(m.fingerprint ?? ''))),
        transcriptStatus: t.status,
        transcriptModel: t.model,
        transcriptMs: t.ms,
        // El audio no se conserva: solo vivía aquí para transcribirlo.
        mediaEncrypted: null,
      },
    });
  }

  async commitTurn(t: TurnCommit) {
    const id = t.conversationId;
    return withSerializableRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const now = new Date();
          await tx.conversation.update({
            where: { id },
            data: {
              stage: t.stage,
              status: t.status,
              // D-025: en claro (es una categoría, no un dato del cliente) para el cierre por
              // inactividad, que no descifra el perfil.
              closeTag: t.profile.closeTag ?? null,
              profileEncrypted: new Uint8Array(
                this.cipher.encrypt(JSON.stringify(t.profile), profileAad(id)),
              ),
            },
          });
          // D-004: la conversación conserva la versión con la que empezó. Solo se fija si no
          // tenía (una publicación urgente pudo cambiarla mientras corría el turno).
          if (t.agentVersionId) {
            await tx.conversation.updateMany({
              where: { id, agentVersionId: null },
              data: { agentVersionId: t.agentVersionId },
            });
          }
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
                ...(o.imageId ? { imageId: o.imageId } : {}),
                // Orden estable entre respuestas del mismo turno.
                occurredAt: new Date(now.getTime() + i),
                ...(i === 0 && t.respondsToAt ? { respondsToAt: t.respondsToAt } : {}),
              },
            });
            ids.push(m.id);
          }
          if (t.llmCalls.length) {
            await tx.llmCall.createMany({
              data: t.llmCalls.map((c) => ({ ...c, conversationId: id })),
            });
          }
          if (t.knowledge?.length) {
            await tx.knowledgeUsage.createMany({
              data: t.knowledge.map((k) => ({
                ...k,
                conversationId: id,
                messageId: ids[0] ?? null,
              })),
            });
          }
          if (t.sale) {
            await tx.sale.create({
              data: {
                conversationId: id,
                process: t.sale.process,
                planCode: t.sale.planCode,
                catalogVersionId: t.sale.catalogVersionId ?? null,
                summaryEncrypted: new Uint8Array(this.cipher.encrypt(t.sale.summary, saleAad(id))),
              },
            });
          }
          if (t.serviceCase) {
            await tx.serviceCase.create({
              data: {
                conversationId: id,
                kind: t.serviceCase.kind,
                summaryEncrypted: new Uint8Array(
                  this.cipher.encrypt(t.serviceCase.summary, serviceCaseAad(id)),
                ),
              },
            });
          }
          if (t.saleDataNote) {
            // Los datos del cliente llegan después del «SÍ»: se agregan al resumen (cifrado).
            const sale = await tx.sale.findUnique({ where: { conversationId: id } });
            if (sale) {
              const prev = this.cipher.decryptString(
                Buffer.from(sale.summaryEncrypted),
                saleAad(id),
              );
              await tx.sale.update({
                where: { conversationId: id },
                data: {
                  summaryEncrypted: new Uint8Array(
                    this.cipher.encrypt(
                      `${prev}
${t.saleDataNote}`,
                      saleAad(id),
                    ),
                  ),
                },
              });
            }
          }
          if (t.consent) {
            // Append-only con cadena de hashes global.
            const last = await tx.consentEvidence.findFirst({
              orderBy: { seq: 'desc' },
              select: { hash: true },
            });
            const prevHash = last?.hash ?? GENESIS_HASH;
            const { textShownHash, templateVersion } = t.consent;
            const replyEnc = this.cipher.encrypt(t.consent.customerReply, consentAad(id));
            const hash = chainHash(prevHash, {
              conversationId: id,
              textShownHash,
              templateVersion,
              customerReplyHash: sha256(t.consent.customerReply),
              acceptedAt: t.consent.acceptedAt.toISOString(),
            });
            await tx.consentEvidence.create({
              data: {
                conversationId: id,
                textShownHash,
                templateVersion,
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
      ),
    );
  }

  /**
   * D-013: reactivación. Conversaciones abiertas donde el robot habló último (mensaje ya
   * enviado) y el cliente lleva `minutes` sin responder: se le encola la siguiente plantilla de
   * reactivación (máx. `max` desde su último mensaje). Las que ya agotaron la reactivación y
   * siguen en silencio se devuelven en `exhausted` para cerrarlas por inactividad.
   */
  async queueReactivations(
    now: Date,
    opts: { minutes: number; max: number; texts: readonly string[] },
  ): Promise<{ sent: number; exhausted: string[] }> {
    const result = { sent: 0, exhausted: [] as string[] };
    if (opts.max <= 0 || !opts.texts.length) return result;
    const cutoff = now.getTime() - opts.minutes * 60_000;
    const rows = await this.prisma.conversation.findMany({
      where: {
        status: { in: ['ACTIVE', 'WAITING_CONSENT'] },
        messages: { none: { direction: 'INBOUND', processedAt: null } },
      },
      select: { id: true, abayaChatId: true, robotUser: true },
    });
    for (const c of rows) {
      const [last, lastInbound] = await Promise.all([
        this.prisma.message.findFirst({
          where: { conversationId: c.id },
          orderBy: { createdAt: 'desc' },
          select: { direction: true, status: true, createdAt: true, sentAt: true },
        }),
        this.prisma.message.findFirst({
          where: { conversationId: c.id, direction: 'INBOUND' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }),
      ]);
      // Solo si el robot habló último y su mensaje ya salió (el tiempo corre desde el envío).
      if (!last || last.direction !== 'OUTBOUND' || last.status !== 'SENT_VERIFIED') continue;
      if ((last.sentAt ?? last.createdAt).getTime() > cutoff) continue;
      const prefix = `react:${lastInbound?.id ?? 'inicio'}:`;
      const [done, usedBefore] = await Promise.all([
        this.prisma.message.count({
          where: { conversationId: c.id, idempotencyKey: { startsWith: prefix } },
        }),
        // Todas las de la conversación: si el cliente contestó y volvió a callar, sigue con la
        // siguiente plantilla en vez de repetir desde la primera.
        this.prisma.message.count({
          where: { conversationId: c.id, idempotencyKey: { startsWith: 'react:' } },
        }),
      ]);
      if (done >= opts.max) {
        result.exhausted.push(c.id);
        continue;
      }
      const key = `${prefix}${done + 1}`;
      const text = opts.texts[usedBefore % opts.texts.length]!;
      try {
        await this.prisma.$transaction(async (tx) => {
          const m = await tx.message.create({
            data: {
              conversationId: c.id,
              direction: 'OUTBOUND',
              idempotencyKey: key,
              bodyEncrypted: new Uint8Array(this.cipher.encrypt(text, outboundAad(key))),
              status: 'PENDING',
              occurredAt: now,
            },
          });
          await tx.outboxEvent.create({
            data: {
              type: 'ReplyReady',
              payload: {
                conversationId: c.id,
                abayaChatId: c.abayaChatId,
                robotUser: c.robotUser,
                messageId: m.id,
              },
            },
          });
        });
        result.sent++;
      } catch (err) {
        // Clave repetida: otro ciclo ya lo encoló.
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    return result;
  }

  /**
   * D-009: conversaciones activas con mensajes del cliente sin responder desde hace más de
   * `afterMs`. A cada una le encola un mensaje de espera (máx. `max` por ráfaga, uno cada
   * `everyMs`) y devuelve sus ids para que el worker vuelva a programar el turno.
   */
  async queueHoldingMessages(
    now: Date,
    opts: { afterMs: number; everyMs: number; max: number; texts: readonly string[] },
  ): Promise<{ waiting: string[]; held: number }> {
    const cutoff = new Date(now.getTime() - opts.afterMs);
    const rows = await this.prisma.conversation.findMany({
      where: {
        status: { in: ['ACTIVE', 'WAITING_CONSENT'] },
        messages: { some: { direction: 'INBOUND', processedAt: null, createdAt: { lt: cutoff } } },
      },
      select: { id: true, abayaChatId: true, robotUser: true },
    });
    let held = 0;
    for (const c of rows) {
      const [oldest, last] = await Promise.all([
        this.prisma.message.findFirst({
          where: { conversationId: c.id, direction: 'INBOUND', processedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        }),
        this.prisma.message.findFirst({
          where: { conversationId: c.id, direction: 'OUTBOUND' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);
      if (!oldest) continue;
      const prefix = `hold:${oldest.id}:`;
      const sent = await this.prisma.message.count({
        where: { conversationId: c.id, idempotencyKey: { startsWith: prefix } },
      });
      if (sent >= opts.max) continue;
      // Ni justo después de otra respuesta ni más de uno cada `everyMs`.
      const gap = sent ? opts.everyMs : opts.afterMs;
      if (last && last.createdAt.getTime() > now.getTime() - gap) continue;
      const key = `${prefix}${sent + 1}`;
      const text = opts.texts[sent % opts.texts.length]!;
      try {
        await this.prisma.$transaction(async (tx) => {
          const m = await tx.message.create({
            data: {
              conversationId: c.id,
              direction: 'OUTBOUND',
              idempotencyKey: key,
              bodyEncrypted: new Uint8Array(this.cipher.encrypt(text, outboundAad(key))),
              status: 'PENDING',
              occurredAt: now,
            },
          });
          await tx.outboxEvent.create({
            data: {
              type: 'ReplyReady',
              payload: {
                conversationId: c.id,
                abayaChatId: c.abayaChatId,
                robotUser: c.robotUser,
                messageId: m.id,
              },
            },
          });
        });
        held++;
      } catch (err) {
        // Clave repetida: otro ciclo ya lo encoló.
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    return { waiting: rows.map((r) => r.id), held };
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
