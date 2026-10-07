import type { LlmRequest } from '@abaya/domain';
import { sha256 } from '@abaya/crypto';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import { MemoryCatalog, readCatalogFile, SYNTHETIC_CATALOG } from '../catalog/catalog.js';
import { ConversationEngine } from '../engine/conversation-engine.js';
import type { TurnOutput } from '../engine/output-schema.js';
import * as T from '../engine/templates/templates.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';
import { MemoryConversationStore } from './memory.store.js';
import { TurnScheduler } from './turn-scheduler.js';
import { TurnService } from './turn.service.js';

const catalog = new MemoryCatalog(await readCatalogFile(SYNTHETIC_CATALOG));
const silent = createLogger('t', { level: 'silent' });
const alerts = {
  raised: [] as string[],
  async raise(code: string) {
    this.raised.push(code);
  },
};

const base = (over: Partial<TurnOutput>): TurnOutput => ({
  intent: 'PREGUNTA',
  reply: 'Claro.',
  option: null,
  planCode: null,
  extracted: { name: null, currentOperator: null, usage: null },
  confidence: 'ALTA',
  ...over,
});

/**
 * LLM simulado "razonable": decide por el estado que trae el prompt dinámico y el último
 * mensaje del cliente. Sirve para probar la integración, no la calidad del modelo.
 */
function fakeBrain(req: LlmRequest): TurnOutput {
  const last = req.messages.at(-1)!.content.toLowerCase();
  const stage = /Etapa actual: (\w+)/.exec(req.systemDynamic)?.[1];
  if (stage === 'PERFIL') {
    if (last.startsWith('soy '))
      return base({
        intent: 'DA_DATO',
        reply: '¡Gracias! ¿Qué operador tienes hoy?',
        extracted: { name: last.slice(4), currentOperator: null, usage: null },
      });
    if (last.startsWith('tengo '))
      return base({
        intent: 'DA_DATO',
        reply: '¿Y cómo usas más tu celular?',
        extracted: { name: null, currentOperator: last.slice(6), usage: null },
      });
    return base({
      intent: 'DA_DATO',
      reply: 'Te recomiendo:\n{{OFERTA:P2}}\n¿Lo tomamos?',
      extracted: { name: null, currentOperator: null, usage: last },
    });
  }
  if (stage === 'OFERTA' && last.includes('quiero')) {
    return base({ intent: 'ACEPTA_PLAN', planCode: 'P2', reply: '¡Excelente elección! 🎉' });
  }
  return base({});
}

function setup() {
  const store = new MemoryConversationStore();
  const engine = new ConversationEngine({ llm: new ScriptedLlmAdapter(fakeBrain), catalog });
  const svc = new TurnService({ store, engine, catalog, alerts, logger: silent });
  return { store, svc };
}

async function say(
  store: MemoryConversationStore,
  svc: TurnService,
  id: string,
  ...texts: string[]
) {
  for (const t of texts) store.addInbound(id, t);
  await svc.handle(id);
}

describe('TurnService: camino de venta completo (Abaya y LLM simulados)', () => {
  it('portabilidad hasta transferencia: venta, consentimiento y eventos en orden', async () => {
    const { store, svc } = setup();
    store.create('c1');
    await say(store, svc, 'c1', 'Hola');
    expect(store.outboundTexts('c1')).toEqual([T.MENU]);
    await say(store, svc, 'c1', 'A');
    await say(store, svc, 'c1', 'soy Ana');
    await say(store, svc, 'c1', 'tengo OperadorX');
    await say(store, svc, 'c1', 'videos y redes');
    expect(store.get('c1').stage).toBe('OFERTA');
    await say(store, svc, 'c1', 'quiero ese plan');
    expect(store.get('c1').status).toBe('WAITING_CONSENT');
    await say(store, svc, 'c1', 'SÍ AUTORIZO');

    const c = store.get('c1');
    expect(c.stage).toBe('TRANSFERENCIA');
    expect(c.status).toBe('TRANSFERRING');
    expect(store.sales).toEqual([
      expect.objectContaining({ process: 'PORTABILIDAD', planCode: 'P2' }),
    ]);
    expect(store.sales[0]!.summary).toContain('Cliente: ana');
    expect(store.sales[0]!.summary).toContain('Operador actual: operadorx');
    // La evidencia apunta al texto legal exacto que se envió al cliente.
    const legal = T.authorization(new Date(store.get('c1').profile.authorizationShownAt!));
    expect(store.outboundTexts('c1').some((t) => t.includes(legal))).toBe(true);
    expect(store.consents[0]).toMatchObject({
      textShownHash: sha256(legal),
      templateVersion: T.TEMPLATE_VERSION,
    });

    // El último turno: despedida → venta → transferencia (después de la despedida).
    const lastTurn = store.events.slice(-3);
    expect(lastTurn.map((e) => e.type)).toEqual([
      'ReplyReady',
      'SaleCompleted',
      'TransferRequested',
    ]);
    expect(lastTurn[2]!.payload).toMatchObject({
      target: 'BACKOFFICE',
      afterMessageIds: [lastTurn[0]!.payload.messageId],
    });
    expect(store.outboundTexts('c1').at(-1)).toBe(T.TRANSFER);
    // Ningún mensaje enviado contiene un marcador sin reemplazar.
    expect(store.outboundTexts('c1').join('\n')).not.toContain('{{');
  });

  it('soporte: plantilla y cierre', async () => {
    const { store, svc } = setup();
    store.create('c2');
    await say(store, svc, 'c2', 'Hola');
    await say(store, svc, 'c2', 'D');
    expect(store.get('c2').status).toBe('CLOSED_SUPPORT');
    expect(store.events.at(-1)).toMatchObject({
      type: 'ConversationClosed',
      payload: { reason: 'SUPPORT' },
    });
  });

  it('mensajes tras el cierre no generan turno', async () => {
    const { store, svc } = setup();
    store.create('c3');
    await say(store, svc, 'c3', 'Hola');
    await say(store, svc, 'c3', 'D');
    const before = store.outboundTexts('c3').length;
    await say(store, svc, 'c3', '¿hola?');
    expect(store.outboundTexts('c3').length).toBe(before);
  });
});

describe('concurrencia', () => {
  it('20 conversaciones simultáneas no mezclan estados', async () => {
    const { store, svc } = setup();
    const scheduler = new TurnScheduler((id) => svc.handle(id), { quietMs: 5 });
    const ids = Array.from({ length: 20 }, (_, i) => `k${i}`);
    for (const id of ids) store.create(id);

    const script = (i: number) => [
      'Hola',
      'A',
      `soy cliente${i}`,
      `tengo operador${i}`,
      `uso${i}`,
      'quiero ese',
      'SÍ AUTORIZO',
    ];
    for (let step = 0; step < 7; step++) {
      for (const [i, id] of ids.entries()) {
        store.addInbound(id, script(i)[step]!);
        scheduler.notify(id);
      }
      await scheduler.idle();
    }

    for (const [i, id] of ids.entries()) {
      const c = store.get(id);
      expect(c.stage).toBe('TRANSFERENCIA');
      expect(c.profile).toMatchObject({
        name: `cliente${i}`,
        currentOperator: `operador${i}`,
        usage: `uso${i}`,
      });
    }
    expect(store.sales).toHaveLength(20);
    for (const s of store.sales) {
      const n = /Cliente: cliente(\d+)/.exec(s.summary)![1];
      expect(s.summary).toContain(`Operador actual: operador${n}`);
    }
  });

  it('ráfaga de 3 mensajes produce una sola respuesta', async () => {
    const { store, svc } = setup();
    store.create('b1');
    await say(store, svc, 'b1', 'Hola');
    await say(store, svc, 'b1', 'A');
    const scheduler = new TurnScheduler((id) => svc.handle(id), { quietMs: 20 });
    for (const t of ['soy Ana', 'perdón', 'escribo rápido']) {
      store.addInbound('b1', t);
      scheduler.notify('b1');
    }
    const before = store.outboundTexts('b1').length;
    await scheduler.idle();
    expect(store.outboundTexts('b1').length).toBe(before + 1);
  });
});
