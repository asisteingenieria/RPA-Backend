import type { TransferJob } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import type { CloseRequest, HandoffOutcome, TransferRequest } from '../actor/browser-actor.js';
import { MemoryAlertAdapter } from '@abaya/alerts';
import { MOCK_TAGS } from '../../test/mock-abaya/templates.js';
import { sel } from '../abaya/selectors.js';
import { HandoffProcessor } from './handoff-processor.js';
import { MemoryHandoffRepository } from './handoff.repository.js';

class FakeActor {
  transfers: TransferRequest[] = [];
  closes: CloseRequest[] = [];
  outcomes: HandoffOutcome[] = [];
  async transfer(req: TransferRequest) {
    this.transfers.push(req);
    return this.outcomes.shift() ?? { result: 'OK' as const };
  }
  async closeConversation(req: CloseRequest) {
    this.closes.push(req);
    return this.outcomes.shift() ?? { result: 'OK' as const };
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
  it('entrega la venta al backoffice (en ySocial: «Finalizar» sin cerrar el caso)', async () => {
    const t = setup();
    expect(await t.p.transfer(job, 0)).toBe('DONE');
    expect(t.actor.transfers[0]).toEqual({ abayaChatId: 'CH-1', target: 'BACKOFFICE' });
    expect(t.repo.transferred).toEqual([{ conversationId: 'c1', target: 'BACKOFFICE' }]);
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
    t.actor.outcomes = [{ result: 'UNCERTAIN', reason: 'el chat sigue en la bandeja' }];
    expect(await t.p.transfer(job, 0)).toBe('NEEDS_REVIEW');
    expect(t.alerts.raised[0]).toMatchObject({ code: 'SALE_NOT_TRANSFERRED', severity: 'CRITICA' });
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

  it('escalamiento humano: el actor recibe el destino HUMAN', async () => {
    const t = setup();
    expect(await t.p.transfer({ ...job, target: 'HUMAN' }, 0)).toBe('DONE');
    expect(t.actor.transfers[0]).toEqual({ abayaChatId: 'CH-1', target: 'HUMAN' });
  });

  it('escalamiento humano sin definir en ySocial: revisión con alerta alta', async () => {
    const t = setup();
    t.actor.outcomes = [{ result: 'UNCERTAIN', reason: 'no definido en ySocial' }];
    expect(await t.p.transfer({ ...job, target: 'HUMAN' }, 0)).toBe('NEEDS_REVIEW');
    expect(t.alerts.raised[0]).toMatchObject({
      code: 'ESCALATION_NOT_TRANSFERRED',
      severity: 'ALTA',
    });
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
    expect(t.actor.closes).toEqual([
      { abayaChatId: 'CH-1', tag: 'SAC - Ecommerce Movil - Detalle plan movil' },
    ]);
  });

  it('D-025: con tipificación marca su etiqueta de ySocial; sin ella, la del motivo', async () => {
    const t = setup();
    await t.p.close({
      conversationId: 'c1',
      abayaChatId: 'CH-1',
      reason: 'SUPPORT',
      tag: 'SAC_FACTURACION',
      afterMessageIds: [],
    });
    await t.p.close({
      conversationId: 'c2',
      abayaChatId: 'CH-2',
      reason: 'INACTIVE',
      tag: 'NO_VENTA_ABANDONA',
      afterMessageIds: [],
    });
    await t.p.close({
      conversationId: 'c3',
      abayaChatId: 'CH-3',
      reason: 'NO_SALE',
      afterMessageIds: [],
    });
    expect(t.actor.closes.map((c) => c.tag)).toEqual([
      'SAC - Ecommerce Movil - Facturacion',
      'No venta - Ecommerce Movil -Cliente abandona conversación',
      'No venta -Ecommerce Movil Reglas de Negocio - Politicas',
    ]);
  });

  it('D-025: cada etiqueta de la tipificación existe en el árbol de ySocial (simulador)', () => {
    for (const label of Object.values(sel.finish.closeTags)) expect(MOCK_TAGS).toContain(label);
  });

  it('cierre incierto: revisión y alerta alta', async () => {
    const t = setup();
    t.actor.outcomes = [{ result: 'UNCERTAIN', reason: 'x' }];
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
