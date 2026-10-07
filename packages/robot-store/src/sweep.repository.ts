import type { PrismaClient } from '@abaya/db';

export interface SweepRepository {
  /**
   * De los chats dados, los que NO tienen nada en curso: ni mensajes del cliente sin atender
   * ni respuestas por enviar (o que ni siquiera tienen conversación registrada).
   */
  idleChats(robotUser: string, abayaChatIds: string[]): Promise<string[]>;
}

export class PrismaSweepRepository implements SweepRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async idleChats(robotUser: string, abayaChatIds: string[]): Promise<string[]> {
    if (!abayaChatIds.length) return [];
    const convs = await this.prisma.conversation.findMany({
      where: { robotUser, abayaChatId: { in: abayaChatIds } },
      select: {
        abayaChatId: true,
        messages: {
          where: {
            OR: [
              { direction: 'INBOUND', processedAt: null },
              { direction: 'OUTBOUND', status: { in: ['PENDING', 'SENDING'] } },
            ],
          },
          select: { id: true },
          take: 1,
        },
      },
    });
    const busy = new Set(convs.filter((c) => c.messages.length).map((c) => c.abayaChatId));
    return abayaChatIds.filter((id) => !busy.has(id));
  }
}
