import type { TransferJob } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import type { HandoffOutcome, TransferRequest } from '../actor/browser-actor.js';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { HandoffProcessor } from './handoff-processor.js';
import { MemoryHandoffRepository } from './handoff.repository.js';

class FakeActor {
  transfers: TransferRequest[] = [];
  closes: string[] = [];
  outcomes: HandoffOutcome[] = [];
  async transfer(req: TransferRequest) {
    this.transfers.push(req);
    return this.outcomes.shift() ?? { result: 'OK' as const, noteWritten: !!req.note };
  }
  async closeConversation(id: string) {
    this.closes.push(id);
    return this.outcomes.shift() ?? { result: 'OK' as const, noteWritten: false };
  }
}

function setup() {
  const actor = new FakeActor();
  const repo = new MemoryHandoffRepository();
  const alerts = new MemoryAlertAdapter();
  const p = new HandoffProcessor({
    actor,
    repo,
    alerts,
    logger: createLogger('t', { level: 'silent' }),
  });
  repo.sales.set('c1', { summary: '*VENTA AGENTE RPA*\nPlan: P1', noteOk: false });
  repo.statuses.set('bye', 'SENT_VERIFIED');
  return { actor, repo, alerts, p };
}

const job: TransferJob = {
  conversationId: 'c1',
  abayaChatId: 'CH-1',
  target: 'BACKOFFICE',
  afterMessageIds: ['bye'],
};

describe('HandoffProcessor.transfer', () => {
  it('escribe la nota con el resumen y transfiere a la cola de backoffice', async () => {
    const t = setup();
    expect(await t.p.transfer(job, 0)).toBe('DONE');
    expect(t.actor.transfers[0]).toEqual({
      abayaChatId: 'CH-1',
      note: '*VENTA AGENTE RPA*\nPlan: P1',
      queueLabel: 'Backoffice ventas',
    });
    expect(t.repo.transferred).toEqual([{ conversationId: 'c1', target: 'BACKOFFICE' }]);
    expect((await t.repo.sale('c1'))?.noteOk).toBe(true);
  });

  it('espera a que la despedida se envíe antes de transferir', async () => {
    const t = setup();
    t.repo.statuses.set('bye', 'PENDING');
    expect(await t.p.transfer(job, 0)).toBe('WAIT');
    expect(t.actor.transfers).toHaveLength(0);
  });

  it('si la despedida quedó UNCERTAIN igual transfiere (la venta no se pierde)', async () => {
    const t = setup();
    t.repo.statuses.set('bye', 'UNCERTAIN');
    expect(await t.p.transfer(job, 0)).toBe('DONE');
  });

  it('falla recuperable: 2 reintentos y luego NEEDS_REVIEW con alerta crítica', async () => {
    const t = setup();
    const fail: HandoffOutcome = {
      result: 'FAILED',
      reason: 'no se pudo abrir el chat',
      noteWritten: false,
    };
    t.actor.outcomes = [fail, fail, fail];
    expect(await t.p.transfer(job, 0)).toBe('RETRY');
    expect(await t.p.transfer(job, 1)).toBe('RETRY');
    expect(await t.p.transfer(job, 2)).toBe('NEEDS_REVIEW');
    expect(t.repo.needsReview).toEqual(['c1']);
    expect(t.alerts.raised).toEqual([
      expect.objectContaining({ code: 'SALE_NOT_TRANSFERRED', severity: 'CRITICA' }),
    ]);
  });

  it('resultado incierto: NEEDS_REVIEW inmediato, sin reintentar a ciegas', async () => {
    const t = setup();
    t.actor.outcomes = [
      { result: 'UNCERTAIN', reason: 'el chat sigue en la bandeja', noteWritten: true },
    ];
    expect(await t.p.transfer(job, 0)).toBe('NEEDS_REVIEW');
    expect(t.alerts.raised[0]).toMatchObject({ code: 'SALE_NOT_TRANSFERRED', severity: 'CRITICA' });
  });

  it('si la nota ya se escribió en un intento previo no se repite', async () => {
    const t = setup();
    t.actor.outcomes = [{ result: 'FAILED', reason: 'x', noteWritten: true }];
    expect(await t.p.transfer(job, 0)).toBe('RETRY');
    expect(await t.p.transfer(job, 1)).toBe('DONE');
    expect(t.actor.transfers[0]!.note).toBeDefined();
    expect(t.actor.transfers[1]!.note).toBeUndefined();
  });

  it('KillSwitch: bloqueado, sin marcar nada', async () => {
    const t = setup();
    t.actor.outcomes = [{ result: 'BLOCKED_KILL_SWITCH' }];
    expect(await t.p.transfer(job, 0)).toBe('BLOCKED');
    expect(t.repo.needsReview).toEqual([]);
  });

  it('venta sin registro: NEEDS_REVIEW', async () => {
    const t = setup();
    t.repo.sales.clear();
    expect(await t.p.transfer(job, 0)).toBe('NEEDS_REVIEW');
    expect(t.actor.transfers).toHaveLength(0);
  });

  it('escalamiento humano va a la cola de asesores con nota de contexto', async () => {
    const t = setup();
    expect(await t.p.transfer({ ...job, target: 'HUMAN' }, 0)).toBe('DONE');
    expect(t.actor.transfers[0]).toMatchObject({ queueLabel: 'Asesores humanos' });
  });
});

describe('HandoffProcessor.close', () => {
  it('cierra tras la despedida', async () => {
    const t = setup();
    expect(
      await t.p.close({
        conversationId: 'c1',
        abayaChatId: 'CH-1',
        reason: 'SUPPORT',
        afterMessageIds: ['bye'],
      }),
    ).toBe('DONE');
    expect(t.actor.closes).toEqual(['CH-1']);
  });

  it('cierre incierto: revisión y alerta alta', async () => {
    const t = setup();
    t.actor.outcomes = [{ result: 'UNCERTAIN', reason: 'x', noteWritten: false }];
    expect(
      await t.p.close({
        conversationId: 'c1',
        abayaChatId: 'CH-1',
        reason: 'NO_SALE',
        afterMessageIds: [],
      }),
    ).toBe('NEEDS_REVIEW');
    expect(t.alerts.raised[0]).toMatchObject({ code: 'CLOSE_UNCERTAIN', severity: 'ALTA' });
  });
});
