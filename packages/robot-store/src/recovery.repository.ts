import type { PrismaClient } from '@abaya/db';

export interface RecoveryRepository {
  /** Envíos que quedaron sin confirmar (proceso caído antes o durante el envío). */
  pendingOutbound(robotUser: string): Promise<{ messageId: string; abayaChatId: string }[]>;
  /** Conversaciones que el robot debería tener abiertas en su bandeja. */
  openConversations(robotUser: string): Promise<{ conversationId: string; abayaChatId: string }[]>;
  markNeedsReview(conversationIds: string[]): Promise<void>;
  /**
   * D-037: conversaciones que ya no están en la bandeja de Avaya → `CLOSED_EXTERNALLY`, y sus
   * respuestas por enviar → `FAILED` (nada se escribió). Solo las de este robot que sigan abiertas.
   * Devuelve cuántas se cerraron.
   */
  closeMissing(robotUser: string, conversationIds: string[]): Promise<number>;
}

const OPEN = ['ACTIVE', 'WAITING_CONSENT'] as const;

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
      where: { robotUser, status: { in: [...OPEN] } },
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

  async closeMissing(robotUser: string, ids: string[]) {
    if (!ids.length) return 0;
    const [closed] = await this.prisma.$transaction([
      this.prisma.conversation.updateMany({
        where: { id: { in: ids }, robotUser, status: { in: [...OPEN] } },
        data: { status: 'CLOSED_EXTERNALLY' },
      }),
      // Solo PENDING: un SENDING pudo haberse escrito y se queda para la regla 2.
      this.prisma.message.updateMany({
        where: {
          conversationId: { in: ids },
          conversation: { robotUser, status: 'CLOSED_EXTERNALLY' },
          direction: 'OUTBOUND',
          status: 'PENDING',
        },
        data: { status: 'FAILED' },
      }),
    ]);
    return closed.count;
  }
}
