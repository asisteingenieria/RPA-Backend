import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FieldCipher, GENESIS_HASH, chainHash, sha256 } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { inboundAad, type LlmRequest } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaCatalog, catalogFileSchema } from '../catalog/catalog.js';
import { ConversationEngine } from '../engine/conversation-engine.js';
import type { TurnOutput } from '../engine/output-schema.js';
import * as T from '../engine/templates/templates.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';
import { OutboxPublisher, type QueuePublisher } from '../outbox/outbox-publisher.js';
import { PrismaConversationStore } from './prisma.store.js';
import { TurnService } from './turn.service.js';

// Integración contra PostgreSQL real (temporal): transacciones, cifrado, outbox y cadena de
// hashes del consentimiento.

const cipher = new FieldCipher(randomBytes(32).toString('base64'));
const plans = catalogFileSchema.parse(
  JSON.parse(readFileSync(new URL('../catalog/plans.synthetic.json', import.meta.url), 'utf8')),
).plans;
let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  for (const p of plans) {
    await db.prisma.plan.create({
      data: { ...p, discountText: p.discountText ?? null, validTo: p.validTo ?? null },
    });
  }
});

const out = (over: Partial<TurnOutput>): TurnOutput => ({
  intent: 'PREGUNTA',
  reply: 'Claro.',
  option: null,
  planCode: null,
  extracted: { name: null, currentOperator: null, usage: null },
  confidence: 'ALTA',
  ...over,
});

function brain(req: LlmRequest): TurnOutput {
  const last = req.messages.at(-1)!.content;
  const stage = /Estado: ([A-ZÁÉÍÓÚÑ]+)/.exec(req.systemDynamic)?.[1];
  if (stage === 'PERFIL') {
    return out({
      intent: 'DA_DATO',
      reply: 'Te recomiendo:\n{{OFERTA:L1}}',
      extracted: { name: 'Ana', currentOperator: null, usage: last },
    });
  }
  if (stage === 'OFERTA')
    return out({ intent: 'ACEPTA_PLAN', planCode: 'L1', reply: '¡Excelente!' });
  return out({});
}

async function setup(abayaChatId = 'CH-77') {
  const catalog = new PrismaCatalog(db.prisma);
  const store = new PrismaConversationStore(db.prisma, cipher);
  const svc = new TurnService({
    store,
    engine: new ConversationEngine({ llm: new ScriptedLlmAdapter(brain), catalog }),
    catalog,
    alerts: { raise: async () => undefined },
    logger: createLogger('t', { level: 'silent' }),
  });
  const conv = await db.prisma.conversation.create({ data: { abayaChatId, robotUser: 'robot' } });
  let n = 0;
  const say = async (text: string) => {
    const fingerprint = `${abayaChatId}-fp-${++n}`;
    await db.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'INBOUND',
        fingerprint,
        bodyEncrypted: new Uint8Array(cipher.encrypt(text, inboundAad(fingerprint))),
        occurredAt: new Date(Date.now() + n),
      },
    });
    await svc.handle(conv.id);
  };
  return { conv, say };
}

describe('PrismaConversationStore + TurnService', () => {
  it('venta completa: estado, venta cifrada, consentimiento encadenado y outbox ordenado', async () => {
    const { conv, say } = await setup();
    for (const t of ['Hola', 'C', 'Ana, uso redes y videos', 'lo quiero', 'SÍ AUTORIZO'])
      await say(t);

    const c = await db.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c.stage).toBe('TRANSFERENCIA');
    expect(c.status).toBe('TRANSFERRING');
    // El perfil está cifrado en reposo.
    expect(Buffer.from(c.profileEncrypted!).toString('latin1')).not.toContain('Ana');

    const sale = await db.prisma.sale.findUniqueOrThrow({ where: { conversationId: conv.id } });
    expect(sale).toMatchObject({ process: 'LINEA_NUEVA', planCode: 'L1', transferredAt: null });
    expect(cipher.decryptString(sale.summaryEncrypted, `sale:${conv.id}`)).toContain('Plan: L1');

    const consents = await db.prisma.consentEvidence.findMany();
    expect(consents).toHaveLength(1);
    const ce = consents[0]!;
    expect(ce.prevHash).toBe(GENESIS_HASH);
    expect(ce.templateVersion).toBe(T.TEMPLATE_VERSION);
    expect(ce.hash).toBe(
      chainHash(GENESIS_HASH, {
        conversationId: conv.id,
        textShownHash: ce.textShownHash,
        templateVersion: ce.templateVersion,
        customerReplyHash: sha256('SÍ AUTORIZO'),
        acceptedAt: ce.acceptedAt.toISOString(),
      }),
    );

    // Todas las respuestas salientes quedaron PENDING, con idempotencia y cifradas.
    const outbound = await db.prisma.message.findMany({
      where: { conversationId: conv.id, direction: 'OUTBOUND' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(outbound.every((m) => m.status === 'PENDING' && m.idempotencyKey)).toBe(true);
    // Menú, pregunta de perfil, oferta, aceptación + autorización, transferencia.
    expect(outbound).toHaveLength(5);

    // Todos los entrantes quedaron procesados.
    expect(
      await db.prisma.message.count({
        where: { conversationId: conv.id, direction: 'INBOUND', processedAt: null },
      }),
    ).toBe(0);

    const llmCalls = await db.prisma.llmCall.count({ where: { conversationId: conv.id } });
    expect(llmCalls).toBe(2); // PERFIL y OFERTA; menú y autorización son deterministas

    const events = await db.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });
    const last3 = events.slice(-3);
    expect(last3.map((e) => e.type)).toEqual(['ReplyReady', 'SaleCompleted', 'TransferRequested']);
    const lastMsg = outbound.at(-1)!;
    expect(last3[0]!.payload).toMatchObject({ messageId: lastMsg.id });
    expect(last3[2]!.payload).toMatchObject({
      target: 'BACKOFFICE',
      afterMessageIds: [lastMsg.id],
    });
  });

  it('tiempo de respuesta: la primera respuesta guarda cuándo se detectó el inicio de la ráfaga', async () => {
    const store = new PrismaConversationStore(db.prisma, cipher);
    const catalog = new PrismaCatalog(db.prisma);
    const svc = new TurnService({
      store,
      engine: new ConversationEngine({ llm: new ScriptedLlmAdapter(brain), catalog }),
      catalog,
      alerts: { raise: async () => undefined },
      logger: createLogger('t', { level: 'silent' }),
    });
    const conv = await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-R', robotUser: 'robot' },
    });
    const t0 = new Date('2026-10-06T15:00:00.000Z');
    for (const [i, text] of ['Hola', 'quiero un plan'].entries()) {
      const fingerprint = `r-${i}`;
      await db.prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: 'INBOUND',
          fingerprint,
          bodyEncrypted: new Uint8Array(cipher.encrypt(text, inboundAad(fingerprint))),
          occurredAt: new Date(t0.getTime() + i * 1500),
          createdAt: new Date(t0.getTime() + i * 1500),
        },
      });
    }
    await svc.handle(conv.id);
    const out = await db.prisma.message.findMany({
      where: { conversationId: conv.id, direction: 'OUTBOUND' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.respondsToAt?.toISOString()).toBe(t0.toISOString());
    expect(out.slice(1).every((m) => m.respondsToAt === null)).toBe(true);
    expect(out[0]!.sentAt).toBeNull();
  });

  it('el historial descifrado alimenta el siguiente turno', async () => {
    const { conv, say } = await setup();
    await say('Hola');
    await say('C');
    const store = new PrismaConversationStore(db.prisma, cipher);
    const input = await store.loadForTurn(conv.id, 10);
    expect(input!.state.history.map((m) => m.text)).toEqual([
      'Hola',
      T.MENU,
      'C',
      '¡Perfecto! 🙌 Para recomendarte el mejor plan, ¿me compartes tu nombre?',
    ]);
    expect(input!.state.profile.process).toBe('LINEA_NUEVA');
  });

  it('la cadena de consentimientos enlaza conversaciones distintas', async () => {
    for (const id of ['CH-A', 'CH-B']) {
      const { say } = await setup(id);
      for (const t of ['Hola', 'C', 'Ana, uso redes', 'lo quiero', 'SÍ AUTORIZO']) await say(t);
    }
    const chain = await db.prisma.consentEvidence.findMany({ orderBy: { acceptedAt: 'asc' } });
    expect(chain).toHaveLength(2);
    expect(chain[1]!.prevHash).toBe(chain[0]!.hash);
  });
});

describe('concurrencia en PostgreSQL', () => {
  it('5 clientes autorizan a la vez: 5 ventas y una sola cadena de consentimientos íntegra', async () => {
    const convs = await Promise.all(
      ['CH-1', 'CH-2', 'CH-3', 'CH-4', 'CH-5'].map((id) => setup(id)),
    );
    for (const t of ['Hola', 'C', 'Ana, uso redes', 'lo quiero']) {
      await Promise.all(convs.map((c) => c.say(t)));
    }
    await Promise.all(convs.map((c) => c.say('SÍ AUTORIZO')));

    expect(await db.prisma.sale.count()).toBe(5);
    const rows = await db.prisma.consentEvidence.findMany();
    expect(rows).toHaveLength(5);
    // Recorrer la cadena desde el génesis: debe pasar por los 5 sin bifurcarse.
    const byPrev = new Map(rows.map((r) => [r.prevHash, r]));
    expect(byPrev.size).toBe(5);
    let cur = byPrev.get(GENESIS_HASH);
    let n = 0;
    while (cur) {
      n++;
      cur = byPrev.get(cur.hash);
    }
    expect(n).toBe(5);
  });
});

describe('OutboxPublisher', () => {
  it('publica en orden con jobId = id del evento y marca publicados', async () => {
    const { say } = await setup();
    for (const t of ['Hola', 'D']) await say(t);
    const published: { queue: string; jobId: string; data: object }[] = [];
    const publisher: QueuePublisher = {
      publish: async (queue, jobId, data) => void published.push({ queue, jobId, data }),
      close: async () => undefined,
    };
    const ob = new OutboxPublisher(db.prisma, publisher, createLogger('t', { level: 'silent' }));
    await ob.tick();
    expect(published.map((p) => p.queue)).toEqual([
      'abaya.outbound.robot',
      'abaya.outbound.robot',
      'abaya.close.robot',
    ]);
    expect(await db.prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
    // Un segundo tick no republica.
    expect(await ob.tick()).toBe(0);
  });
});

describe('PrismaCatalog', () => {
  it('solo devuelve planes activos y vigentes del proceso, ordenados por precio', async () => {
    const catalog = new PrismaCatalog(db.prisma);
    expect((await catalog.plansFor('PORTABILIDAD')).map((p) => p.code)).toEqual(['P1', 'P2']);
    expect((await catalog.plansFor('LINEA_NUEVA')).map((p) => p.code)).toEqual(['L1']);
    expect((await catalog.get('L9'))?.active).toBe(false);
  });
});
