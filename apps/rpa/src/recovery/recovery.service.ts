import type { PrismaClient } from '@abaya/db';
import type { AlertPort } from '@abaya/domain';
import type { Logger } from '@abaya/logger';

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

/**
 * Reconciliación al iniciar o recuperar la sesión (sección 6.1, paso 7):
 * 1. Reencola los envíos PENDING/SENDING: el BrowserActor es idempotente (verifica en
 *    pantalla) y nunca reintenta a ciegas un SENDING (regla 2).
 * 2. Conversaciones abiertas en BD que ya no están en la bandeja de Abaya (las movió un
 *    humano o expiraron): revisión humana, porque el robot ya no puede actuar en ellas.
 */
export class RecoveryService {
  constructor(
    private readonly d: {
      robotUser: string;
      repo: RecoveryRepository;
      /** Lectura de la bandeja (sin clics). */
      inboxChatIds: () => Promise<string[]>;
      enqueueOutbound: (messageId: string, abayaChatId: string) => Promise<void>;
      alerts: AlertPort;
      logger: Logger;
    },
  ) {}

  async run(): Promise<{ requeued: number; missing: number }> {
    const pending = await this.d.repo.pendingOutbound(this.d.robotUser);
    for (const p of pending) await this.d.enqueueOutbound(p.messageId, p.abayaChatId);

    const inbox = new Set(await this.d.inboxChatIds());
    const open = await this.d.repo.openConversations(this.d.robotUser);
    // Bandeja vacía con conversaciones abiertas: lo más probable es que no cargó; no marcar.
    const missing = inbox.size === 0 ? [] : open.filter((c) => !inbox.has(c.abayaChatId));
    if (missing.length) {
      await this.d.repo.markNeedsReview(missing.map((m) => m.conversationId));
      await this.d.alerts.raise('CHATS_MISSING_FROM_INBOX', 'ALTA', {
        robotUser: this.d.robotUser,
        conversationIds: missing.map((m) => m.conversationId),
      });
    }
    this.d.logger.info(
      { robotUser: this.d.robotUser, requeued: pending.length, missing: missing.length },
      'reconciliación completada',
    );
    return { requeued: pending.length, missing: missing.length };
  }
}
