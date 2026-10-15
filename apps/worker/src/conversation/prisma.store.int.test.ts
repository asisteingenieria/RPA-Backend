import { randomBytes } from 'node:crypto';
import { FieldCipher, GENESIS_HASH, chainHash, sha256 } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import {
  DEFAULT_AGENT_CONFIG,
  audioAad,
  inboundAad,
  outboundAad,
  type LlmRequest,
} from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublishedCatalog, DEFAULT_CATALOG_BRAIN } from '@abaya/knowledge';
import { PublishedBrainCatalog, readCatalogFile, SYNTHETIC_CATALOG } from '../catalog/catalog.js';
import { ConversationEngine } from '../engine/conversation-engine.js';
import type { TurnOutput } from '../engine/output-schema.js';
import * as T from '../engine/templates/templates.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';
import { OutboxPublisher, type QueuePublisher } from '../outbox/outbox-publisher.js';
import { purgeStaleVoiceAudio } from '../maintenance/maintenance.js';
import { ScriptedSpeechAdapter } from '../speech/from-config.js';
import { VOICE_PREFIX } from '../engine/voice.js';
import { PrismaConversationStore } from './prisma.store.js';
import { TurnService } from './turn.service.js';

// Integración contra PostgreSQL real (temporal): transacciones, cifrado, outbox y cadena de
// hashes del consentimiento.

const cipher = new FieldCipher(randomBytes(32).toString('base64'));
const plans = await readCatalogFile(SYNTHETIC_CATALOG);
let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  // Catálogo sintético publicado como v1 del Brain conectado al agente (v1.9).
  await createPublishedCatalog(db.prisma, {
    name: DEFAULT_CATALOG_BRAIN,
    records: plans,
    actor: 'seed',
    action: 'BRAIN_SEEDED',
    note: 'prueba',
  });
});

const out = (over: Partial<TurnOutput>): TurnOutput => ({
  intent: 'PREGUNTA',
  reply: 'Claro.',
  option: null,
  planCode: null,
  extracted: { name: null, currentOperator: null, lineType: null, usage: null },
  tipificacion: null,
  confidence: 'ALTA',
  ...over,
});

function brain(req: LlmRequest): TurnOutput {
  const last = req.messages.at(-1)!.content;
  const stage = /Etapa actual: ([A-Z_]+)/.exec(req.systemDynamic)?.[1];
  if (stage === 'PERFIL') {
    return out({
      intent: 'DA_DATO',
      reply: 'Te recomiendo:\n{{OFERTA:M1}}',
      extracted: { name: 'Ana', currentOperator: null, lineType: null, usage: last },
    });
  }
  if (stage === 'OFERTA')
    return out({ intent: 'ACEPTA_PLAN', planCode: 'M1', reply: '¡Excelente!' });
  // D-023: en el menú, pregunta por una portabilidad que ya solicitó.
  if (stage === 'MENU' && /portabilidad/i.test(last))
    return out({ intent: 'CONSULTA_PORTABILIDAD', reply: 'Entiendo.' });
  return out({});
}

async function publishedCatalog() {
  const c = new PublishedBrainCatalog(db.prisma, createLogger('t', { level: 'silent' }));
  await c.refresh();
  return c;
}

async function setup(abayaChatId = 'CH-77') {
  const catalog = await publishedCatalog();
  const store = new PrismaConversationStore(db.prisma, cipher);
  const svc = new TurnService({
    store,
    engine: new ConversationEngine({ llm: new ScriptedLlmAdapter(brain), catalog }),
    catalog,
    alerts: { raise: async () => undefined },
    logger: createLogger('t', { level: 'silent' }),
    speech: new ScriptedSpeechAdapter(),
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
  /** D-010: nota de voz como la guarda la pasarela (audio cifrado, texto vacío, PENDING). */
  const speak = async (said: string) => {
    const fingerprint = `${abayaChatId}-fp-${++n}`;
    const m = await db.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'INBOUND',
        fingerprint,
        bodyEncrypted: new Uint8Array(cipher.encrypt('', inboundAad(fingerprint))),
        occurredAt: new Date(Date.now() + n),
        mediaKind: 'AUDIO',
        mediaMimeType: 'audio/ogg',
        mediaDurationSec: 9,
        mediaEncrypted: new Uint8Array(cipher.encrypt(Buffer.from(said), audioAad(fingerprint))),
        transcriptStatus: 'PENDING',
      },
    });
    await svc.handle(conv.id);
    return m.id;
  };
  return { conv, say, speak };
}

describe('PrismaConversationStore + TurnService', () => {
  it('venta completa: estado, venta cifrada, consentimiento encadenado y outbox ordenado', async () => {
    const { conv, say } = await setup();
    // D-013: tras el «SÍ», el cliente manda los datos que pide el asesor y se finaliza.
    for (const t of [
      'Hola',
      'B',
      'Ana, uso redes y videos',
      'lo quiero',
      'SÍ AUTORIZO',
      '1000000000 Ana Demo ana@ejemplo.test',
    ])
      await say(t);

    const c = await db.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c.stage).toBe('TRANSFERENCIA');
    expect(c.status).toBe('TRANSFERRING');
    // El perfil está cifrado en reposo.
    expect(Buffer.from(c.profileEncrypted!).toString('latin1')).not.toContain('Ana');

    const sale = await db.prisma.sale.findUniqueOrThrow({ where: { conversationId: conv.id } });
    expect(sale).toMatchObject({ process: 'MIGRACION', planCode: 'M1', transferredAt: null });
    expect(cipher.decryptString(sale.summaryEncrypted, `sale:${conv.id}`)).toContain('Plan: M1');
    // v1.9: de qué versión del catálogo salió el plan vendido y qué vio el cliente en cada turno.
    const published = await db.prisma.brainVersion.findFirstOrThrow({
      where: { status: 'PUBLISHED' },
    });
    expect(sale.catalogVersionId).toBe(published.id);
    const usage = await db.prisma.knowledgeUsage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(usage.map((u) => [u.brainVersion, u.rendered])).toEqual([
      [1, ['M1']], // oferta
      [1, []], // aceptación
    ]);
    expect(usage[0]!.messageId).not.toBeNull();

    const consents = await db.prisma.consentEvidence.findMany();
    expect(consents).toHaveLength(1);
    const ce = consents[0]!;
    expect(ce.prevHash).toBe(GENESIS_HASH);
    expect(ce.templateVersion).toBe(T.authorizationFor(DEFAULT_AGENT_CONFIG, new Date()).version);
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
    // Menú, pregunta de perfil, oferta, aceptación + autorización, pedido de datos, transferencia.
    expect(outbound).toHaveLength(6);

    // Todos los entrantes quedaron procesados.
    expect(
      await db.prisma.message.count({
        where: { conversationId: conv.id, direction: 'INBOUND', processedAt: null },
      }),
    ).toBe(0);

    const llmCalls = await db.prisma.llmCall.count({ where: { conversationId: conv.id } });
    expect(llmCalls).toBe(2); // PERFIL y OFERTA; menú y autorización son deterministas

    const events = await db.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });
    const last4 = events.slice(-4);
    expect(last4.map((e) => e.type)).toEqual([
      'ReplyReady', // pedido de datos
      'SaleCompleted', // con el «SÍ»
      'ReplyReady', // transferencia
      'TransferRequested',
    ]);
    const lastMsg = outbound.at(-1)!;
    expect(last4[2]!.payload).toMatchObject({ messageId: lastMsg.id });
    expect(last4[3]!.payload).toMatchObject({
      target: 'BACKOFFICE',
      afterMessageIds: [lastMsg.id],
    });
  });

  it('tiempo de respuesta: la primera respuesta guarda cuándo se detectó el inicio de la ráfaga', async () => {
    const store = new PrismaConversationStore(db.prisma, cipher);
    const catalog = await publishedCatalog();
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
    await say('B');
    const store = new PrismaConversationStore(db.prisma, cipher);
    const input = await store.loadForTurn(conv.id, 10);
    expect(input!.state.history.map((m) => m.text)).toEqual([
      'Hola',
      T.MENU,
      'B',
      T.firstQuestionFor(DEFAULT_AGENT_CONFIG, 'MIGRACION', new Date()),
    ]);
    expect(input!.state.profile.process).toBe('MIGRACION');
  });

  it('D-010: transcribe la nota de voz, la guarda cifrada, borra el audio y la marca en el historial', async () => {
    const { conv, say, speak } = await setup('CH-VOZ');
    await say('Hola');
    await say('B');
    const id = await speak('redes sociales y música');
    const m = await db.prisma.message.findUniqueOrThrow({ where: { id } });
    expect(m).toMatchObject({
      transcriptStatus: 'OK',
      transcriptModel: 'simulado',
      mediaEncrypted: null,
    });
    expect(m.processedAt).not.toBeNull();
    expect(cipher.decryptString(m.bodyEncrypted, inboundAad(m.fingerprint!))).toBe(
      'redes sociales y música',
    );
    const input = await new PrismaConversationStore(db.prisma, cipher).loadForTurn(conv.id, 10);
    expect(input!.state.history.map((h) => h.text)).toContain(
      `${VOICE_PREFIX}redes sociales y música`,
    );
  });

  it('D-010: el audio que quedó sin transcribir se borra a las 24 h', async () => {
    const conv = await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-OLD', robotUser: 'robot' },
    });
    const old = await db.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'INBOUND',
        fingerprint: 'old-fp',
        bodyEncrypted: new Uint8Array(cipher.encrypt('', inboundAad('old-fp'))),
        occurredAt: new Date(),
        mediaKind: 'AUDIO',
        mediaMimeType: 'audio/ogg',
        mediaEncrypted: new Uint8Array([1, 2, 3]),
        transcriptStatus: 'PENDING',
      },
    });
    expect(await purgeStaleVoiceAudio(db.prisma, new Date())).toBe(0);
    expect(await purgeStaleVoiceAudio(db.prisma, new Date(Date.now() + 25 * 3_600_000))).toBe(1);
    expect(await db.prisma.message.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      mediaEncrypted: null,
      transcriptStatus: 'FAILED',
    });
  });

  it('D-023: validación de portabilidad: caso de servicio cifrado al backoffice, sin venta', async () => {
    const { conv, say } = await setup('CH-PORTA');
    await say('Hola');
    await say('Hola, solicité una portabilidad y no sé si ya quedó');
    await say('No');
    await say('1020304050 Ana María Pérez ana@correo.com');
    const c = await db.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(c.stage).toBe('TRANSFERENCIA');
    expect(await db.prisma.sale.count()).toBe(0);
    expect(await db.prisma.consentEvidence.count()).toBe(0);
    const sc = await db.prisma.serviceCase.findUniqueOrThrow({
      where: { conversationId: conv.id },
    });
    expect(sc).toMatchObject({ kind: 'VALIDACION_PORTABILIDAD', transferredAt: null });
    const summary = cipher.decryptString(sc.summaryEncrypted, `service-case:${conv.id}`);
    expect(summary).toContain('Validación de portabilidad');
    expect(summary).toContain('Documento: 1020304050');
    expect(summary).toContain('Correo: ana@correo.com');
    const transfer = await db.prisma.outboxEvent.findFirstOrThrow({
      where: { type: 'TransferRequested' },
    });
    expect(transfer.payload).toMatchObject({ target: 'BACKOFFICE' });
  });

  it('la cadena de consentimientos enlaza conversaciones distintas', async () => {
    for (const id of ['CH-A', 'CH-B']) {
      const { say } = await setup(id);
      for (const t of ['Hola', 'B', 'Ana, uso redes', 'lo quiero', 'SÍ AUTORIZO']) await say(t);
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
    for (const t of ['Hola', 'B', 'Ana, uso redes', 'lo quiero']) {
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
    for (const t of ['Hola', 'D', 'no gracias']) await say(t);
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
      'abaya.outbound.robot',
      'abaya.close.robot',
    ]);
    expect(await db.prisma.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
    // Un segundo tick no republica.
    expect(await ob.tick()).toBe(0);
  });
});

describe('PublishedBrainCatalog', () => {
  it('consultar_planes: solo planes del proceso de la versión publicada, ordenados por precio', async () => {
    const catalog = await publishedCatalog();
    const porta = await catalog.query('PORTABILIDAD');
    expect(porta.plans.map((p) => p.code)).toEqual(['P1', 'P2']);
    expect(porta.source).toMatchObject({ brainName: DEFAULT_CATALOG_BRAIN, version: 1 });
    expect((await catalog.query('LINEA_NUEVA')).plans.map((p) => p.code)).toEqual(['L1']);
  });

  it('sin Brain de catálogo conectado: SIN_PLANES explícito', async () => {
    await db.prisma.agentBrain.deleteMany();
    const catalog = await publishedCatalog();
    expect(await catalog.query('MIGRACION')).toEqual({
      status: 'SIN_PLANES',
      process: 'MIGRACION',
      plans: [],
      source: null,
      images: [],
      videoImages: [],
      imagesOnly: false,
    });
  });
});

describe('D-009: mensajes de espera', () => {
  it('el cliente que espera más de 2 min recibe «dame un momento»; uno cada 3 min, máx. 2', async () => {
    const store = new PrismaConversationStore(db.prisma, cipher);
    const conv = await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-HOLD', robotUser: 'robot' },
    });
    const t0 = new Date('2026-10-08T15:00:00Z');
    await db.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'INBOUND',
        fingerprint: 'hold-fp-1',
        bodyEncrypted: new Uint8Array(cipher.encrypt('¿Y el precio?', inboundAad('hold-fp-1'))),
        occurredAt: t0,
        createdAt: t0,
      },
    });
    const opts = { afterMs: 120_000, everyMs: 180_000, max: 2, texts: T.HOLDING_MESSAGES };
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    const holds = async () =>
      db.prisma.message.findMany({
        where: { conversationId: conv.id, direction: 'OUTBOUND' },
        orderBy: { createdAt: 'asc' },
      });

    // 1 min: todavía no.
    expect((await store.queueHoldingMessages(at(60), opts)).held).toBe(0);
    // 2 min: primer aviso, con su ReplyReady para el robot dueño del chat.
    const r = await store.queueHoldingMessages(at(121), opts);
    expect(r).toEqual({ waiting: [conv.id], held: 1 });
    const [first] = await holds();
    expect(cipher.decryptString(first!.bodyEncrypted, outboundAad(first!.idempotencyKey!))).toBe(
      T.HOLDING_MESSAGES[0],
    );
    const ev = await db.prisma.outboxEvent.findFirst({ where: { type: 'ReplyReady' } });
    expect(ev?.payload).toMatchObject({ messageId: first!.id, robotUser: 'robot' });
    // 3 min: muy pronto para otro. Sigue en «waiting» para volver a programar el turno.
    await db.prisma.message.update({ where: { id: first!.id }, data: { createdAt: at(121) } });
    expect(await store.queueHoldingMessages(at(180), opts)).toEqual({
      waiting: [conv.id],
      held: 0,
    });
    // 5 min: segundo aviso; luego llega al máximo.
    expect((await store.queueHoldingMessages(at(302), opts)).held).toBe(1);
    const all = await holds();
    await db.prisma.message.update({ where: { id: all[1]!.id }, data: { createdAt: at(302) } });
    expect((await store.queueHoldingMessages(at(900), opts)).held).toBe(0);
    expect(await holds()).toHaveLength(2);

    // Ya respondido: no hay nada que esperar.
    await db.prisma.message.updateMany({
      where: { conversationId: conv.id, direction: 'INBOUND' },
      data: { processedAt: at(910) },
    });
    expect(await store.queueHoldingMessages(at(1000), opts)).toEqual({ waiting: [], held: 0 });
  });
});

describe('D-013: reactivación', () => {
  it('si el cliente no responde, plantillas de reactivación en orden; agotadas → cierre', async () => {
    const store = new PrismaConversationStore(db.prisma, cipher);
    const conv = await db.prisma.conversation.create({
      data: { abayaChatId: 'CH-REACT', robotUser: 'robot' },
    });
    const t0 = new Date('2026-10-09T15:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    await db.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'INBOUND',
        fingerprint: 'react-fp-1',
        bodyEncrypted: new Uint8Array(cipher.encrypt('Hola', inboundAad('react-fp-1'))),
        processedAt: t0,
        occurredAt: t0,
        createdAt: t0,
      },
    });
    const bot = async (key: string, when: Date, status: 'PENDING' | 'SENT_VERIFIED') =>
      db.prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          idempotencyKey: key,
          bodyEncrypted: new Uint8Array(cipher.encrypt('¿Con qué operador?', outboundAad(key))),
          status,
          occurredAt: when,
          createdAt: when,
          sentAt: status === 'SENT_VERIFIED' ? when : null,
        },
      });
    const reply = await bot('turno-1', at(0.5), 'PENDING');
    const opts = { minutes: 5, max: 2, texts: ['¿sigues ahí? 👀', '¿te puedo llamar? 📲'] };
    const texts = async () =>
      (
        await db.prisma.message.findMany({
          where: { conversationId: conv.id, idempotencyKey: { startsWith: 'react:' } },
          orderBy: { createdAt: 'asc' },
        })
      ).map((m) => cipher.decryptString(m.bodyEncrypted, outboundAad(m.idempotencyKey!)));

    // La respuesta aún no salió: no se reactiva (el tiempo corre desde el envío).
    expect(await store.queueReactivations(at(10), opts)).toEqual({ sent: 0, exhausted: [] });
    await db.prisma.message.update({
      where: { id: reply.id },
      data: { status: 'SENT_VERIFIED', sentAt: at(1) },
    });
    // 4 min de silencio: todavía no. 6 min: la primera.
    expect((await store.queueReactivations(at(5), opts)).sent).toBe(0);
    expect((await store.queueReactivations(at(7), opts)).sent).toBe(1);
    expect(await texts()).toEqual(['¿sigues ahí? 👀']);
    // Mientras la reactivación no se envía, no se manda otra.
    expect((await store.queueReactivations(at(20), opts)).sent).toBe(0);
    await db.prisma.message.updateMany({
      where: { conversationId: conv.id, idempotencyKey: { startsWith: 'react:' } },
      data: { status: 'SENT_VERIFIED', sentAt: at(7) },
    });
    expect((await store.queueReactivations(at(13), opts)).sent).toBe(1);
    expect(await texts()).toEqual(['¿sigues ahí? 👀', '¿te puedo llamar? 📲']);
    await db.prisma.message.updateMany({
      where: { conversationId: conv.id, idempotencyKey: { startsWith: 'react:' } },
      data: { status: 'SENT_VERIFIED', sentAt: at(13) },
    });
    // Agotada y sigue en silencio: se devuelve para cerrar.
    expect(await store.queueReactivations(at(19), opts)).toEqual({
      sent: 0,
      exhausted: [conv.id],
    });
  });

  it('reactivación: nunca repite plantilla en la conversación, aunque el cliente haya contestado', async () => {
    const store = new PrismaConversationStore(db.prisma, cipher);
    const conv = await db.prisma.conversation.create({
      data: { abayaChatId: 'REACT-2', robotUser: 'robot-ventas-01' },
    });
    const t0 = new Date('2026-10-09T15:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const opts = { minutes: 2, max: 3, texts: ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'] };
    const sent = (min: number) =>
      db.prisma.message.updateMany({
        where: { conversationId: conv.id, direction: 'OUTBOUND', status: 'PENDING' },
        data: { status: 'SENT_VERIFIED', sentAt: at(min) },
      });
    const texts = async () =>
      (
        await db.prisma.message.findMany({
          where: { conversationId: conv.id, idempotencyKey: { startsWith: 'react:' } },
          orderBy: { createdAt: 'asc' },
        })
      ).map((m) => cipher.decryptString(m.bodyEncrypted, outboundAad(m.idempotencyKey!)));
    const bot = (key: string, min: number) =>
      db.prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          idempotencyKey: key,
          bodyEncrypted: new Uint8Array(
            cipher.encrypt('¿Te gustaría este plan?', outboundAad(key)),
          ),
          status: 'SENT_VERIFIED',
          occurredAt: at(min),
          createdAt: at(min),
          sentAt: at(min),
        },
      });
    await bot('turno-a', 0);
    expect((await store.queueReactivations(at(3), opts)).sent).toBe(1);
    await sent(3);
    expect((await store.queueReactivations(at(6), opts)).sent).toBe(1);
    await sent(6);
    // El cliente contesta y el robot responde; luego vuelve a callar.
    await db.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'INBOUND',
        fingerprint: 'f'.repeat(64),
        bodyEncrypted: new Uint8Array(cipher.encrypt('sí, aquí estoy', inboundAad('f'.repeat(64)))),
        occurredAt: at(7),
        createdAt: at(7),
        processedAt: at(7),
      },
    });
    await bot('turno-b', 8);
    expect((await store.queueReactivations(at(11), opts)).sent).toBe(1);
    expect(await texts()).toEqual(['uno', 'dos', 'tres']);
  });
});
