import type { PrismaClient } from '@abaya/db';

export interface RecoveryRepository {
  /** Envíos que quedaron sin confirmar (proceso caído antes o durante el envío). */
  pendingOutbound(robotUser: string): Promise<{ messageId: string; abayaChatId: string }[]>;
  /** Conversaciones que el robot debería tener abiertas en su bandeja. */
  openConversations(robotUser: string): Promise<{ conversationId: string; abayaChatId: string }[]>;
  markNeedsReview(conversationIds: string[]): Promise<void>;
}

export class PrismaRecoveryRepository implements RecoveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async pendingOutbound(robotUser: string) {
    const rows = await this.prisma.message.findMany({
      where: {
        direction: 'OUTBOUND',
        status: { in: ['PENDING', 'SENDING'] },
        conversation: { robotUser },
      },
      orderBy: { occurredAt: 'asc' },
      select: { id: true, conversation: { select: { abayaChatId: true } } },
    });
    return rows.map((r) => ({ messageId: r.id, abayaChatId: r.conversation.abayaChatId }));
  }

  async openConversations(robotUser: string) {
    const rows = await this.prisma.conversation.findMany({
      where: { robotUser, status: { in: ['ACTIVE', 'WAITING_CONSENT'] } },
      select: { id: true, abayaChatId: true },
    });
    return rows.map((r) => ({ conversationId: r.id, abayaChatId: r.abayaChatId }));
  }

  async markNeedsReview(ids: string[]) {
    if (!ids.length) return;
    await this.prisma.conversation.updateMany({
      where: { id: { in: ids } },
      data: { status: 'NEEDS_REVIEW' },
    });
  }
}
