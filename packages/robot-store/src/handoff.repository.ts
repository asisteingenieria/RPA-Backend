import type { FieldCipher } from '@abaya/crypto';
import type { PrismaClient } from '@abaya/db';
import { saleAad, serviceCaseAad, type OutboundStatus } from '@abaya/domain';

export interface HandoffRepository {
  outboundStatuses(messageIds: string[]): Promise<OutboundStatus[]>;
  /**
   * Resumen descifrado y si la nota ya quedó escrita en un intento previo. D-023: o el del caso de
   * servicio (validación de portabilidad) que también pasa al backoffice con «Finalizar».
   */
  sale(conversationId: string): Promise<{ summary: string; noteOk: boolean } | null>;
  markNoteOk(conversationId: string): Promise<void>;
  markTransferred(conversationId: string, target: 'BACKOFFICE' | 'HUMAN'): Promise<void>;
  markNeedsReview(conversationId: string): Promise<void>;
}

export class PrismaHandoffRepository implements HandoffRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async outboundStatuses(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.prisma.message.findMany({
      where: { id: { in: ids } },
      select: { status: true },
    });
    return rows.map((r) => r.status ?? 'PENDING');
  }

  async sale(conversationId: string) {
    const s = await this.prisma.sale.findUnique({ where: { conversationId } });
    if (s)
      return {
        summary: this.cipher.decryptString(s.summaryEncrypted, saleAad(conversationId)),
        noteOk: s.backofficeNoteOk,
      };
    const c = await this.prisma.serviceCase.findUnique({ where: { conversationId } });
    if (!c) return null;
    return {
      summary: this.cipher.decryptString(c.summaryEncrypted, serviceCaseAad(conversationId)),
      noteOk: false,
    };
  }

  async markNoteOk(conversationId: string) {
    await this.prisma.sale.updateMany({
      where: { conversationId },
      data: { backofficeNoteOk: true },
    });
  }

  async markTransferred(conversationId: string, target: 'BACKOFFICE' | 'HUMAN') {
    await this.prisma.$transaction(async (tx) => {
      // Escalamientos humanos se registran como transferidos también: salen del robot.
      await tx.conversation.update({
        where: { id: conversationId },
        data: { status: 'TRANSFERRED_BACKOFFICE' },
      });
      if (target === 'BACKOFFICE') {
        // La venta o, si no hay, el caso de servicio (D-023).
        const now = new Date();
        const sold = await tx.sale.updateMany({
          where: { conversationId },
          data: { transferredAt: now },
        });
        if (!sold.count)
          await tx.serviceCase.updateMany({
            where: { conversationId },
            data: { transferredAt: now },
          });
        await tx.outboxEvent.create({
          data: { type: 'ConversationTransferred', payload: { conversationId, target } },
        });
      }
    });
  }

  async markNeedsReview(conversationId: string) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: 'NEEDS_REVIEW' },
    });
  }
}

export class MemoryHandoffRepository implements HandoffRepository {
  readonly statuses = new Map<string, OutboundStatus>();
  readonly sales = new Map<string, { summary: string; noteOk: boolean }>();
  readonly transferred: { conversationId: string; target: string }[] = [];
  readonly needsReview: string[] = [];

  async outboundStatuses(ids: string[]) {
    return ids.map((id) => this.statuses.get(id) ?? 'PENDING');
  }
  async sale(id: string) {
    return this.sales.get(id) ?? null;
  }
  async markNoteOk(id: string) {
    const s = this.sales.get(id);
    if (s) s.noteOk = true;
  }
  async markTransferred(conversationId: string, target: string) {
    this.transferred.push({ conversationId, target });
  }
  async markNeedsReview(id: string) {
    this.needsReview.push(id);
  }
}
