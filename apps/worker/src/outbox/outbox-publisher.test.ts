import { describe, expect, it } from 'vitest';
import { routeEvent } from './outbox-publisher.js';

describe('routeEvent', () => {
  it('ReplyReady → abaya.outbound', () => {
    expect(
      routeEvent('ReplyReady', {
        messageId: 'm1',
        abayaChatId: 'CH-1',
        robotUser: 'robot-ventas-01',
        conversationId: 'c',
      }),
    ).toEqual({
      queue: 'abaya.outbound.robot-ventas-01',
      data: { messageId: 'm1', abayaChatId: 'CH-1' },
    });
  });

  it('TransferRequested → abaya.transfer con los mensajes que deben ir antes', () => {
    expect(
      routeEvent('TransferRequested', {
        conversationId: 'c',
        abayaChatId: 'CH-1',
        robotUser: 'robot-ventas-01',
        target: 'BACKOFFICE',
        afterMessageIds: ['m9'],
      }),
    ).toEqual({
      queue: 'abaya.transfer.robot-ventas-01',
      data: {
        conversationId: 'c',
        abayaChatId: 'CH-1',
        target: 'BACKOFFICE',
        afterMessageIds: ['m9'],
      },
    });
  });

  it('ConversationClosed → abaya.close', () => {
    expect(
      routeEvent('ConversationClosed', {
        conversationId: 'c',
        abayaChatId: 'CH-1',
        robotUser: 'robot-ventas-01',
        reason: 'SUPPORT',
      })?.queue,
    ).toBe('abaya.close.robot-ventas-01');
  });

  it('un evento de acción sin robotUser es un error (no se adivina la cola)', () => {
    expect(() => routeEvent('ReplyReady', { messageId: 'm1', abayaChatId: 'CH-1' })).toThrow(
      /robotUser/,
    );
  });

  it('SaleCompleted y NeedsReview no generan trabajo en Abaya', () => {
    expect(routeEvent('SaleCompleted', {})).toBeNull();
    expect(routeEvent('NeedsReview', {})).toBeNull();
  });
});
