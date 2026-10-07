import { randomBytes } from 'node:crypto';
import { FieldCipher, sha256 } from '@abaya/crypto';
import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { inboundAad, outboundAad, type LlmRequest } from '@abaya/domain';
import {
  bootstrapLegacyCatalog,
  CatalogTableParser,
  createPublishedCatalog,
  DEFAULT_CATALOG_BRAIN,
  ingestSource,
  PgBlobStore,
  replaceDraft,
  versionContent,
  type CatalogDiff,
} from '@abaya/knowledge';
import { createLogger } from '@abaya/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublishedBrainCatalog, readCatalogFile, SYNTHETIC_CATALOG } from '../catalog/catalog.js';
import { PrismaConversationStore } from '../conversation/prisma.store.js';
import { TurnService } from '../conversation/turn.service.js';
import { ConversationEngine } from '../engine/conversation-engine.js';
import type { TurnOutput } from '../engine/output-schema.js';
import { evaluateBrainVersion } from '../evals/brain-evaluation.js';
import { heuristicBrain } from '../llm/adapters/heuristic-brain.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';

// Ciclo completo de un Brain de catálogo contra PostgreSQL real (v1.9, D-001): ingesta,
// borrador con diff, publicación con la suite, auditoría, reversión y trazabilidad por turno.

const cipher = new FieldCipher(randomBytes(32).toString('base64'));
const logger = createLogger('t', { level: 'silent' });
const plans = await readCatalogFile(SYNTHETIC_CATALOG);
const HEADER =
  'Proceso;ID;Nombre;Datos;GB para compartir;Incluye;Servicios adicionales;Apps ilimitadas;Llamadas y mensajes;Precio;Descuento';
/** El catálogo sintético con otro precio para P1. */
const csvWithP1 = (price: string) =>
  [
    HEADER,
    `Portabilidad;P1;Plan Porta Básico (DEMO);10 GB;;Redes sociales incluidas (DEMO);;;Minutos ilimitados a todo operador (DEMO);${price};`,
    'Portabilidad;P2;Plan Porta Plus (DEMO);30 GB;;;Roaming DEMO;;Minutos ilimitados a todo operador (DEMO);59900;Descuento DEMO del 20% durante 6 meses (texto de ejemplo, no aprobado).',
    'Migración;M1;Plan Migra Esencial (DEMO);15 GB;;Conservas tu número (DEMO);;;;45900;',
    'Migración;M2;Plan Migra Max (DEMO);40 GB;;Conservas tu número (DEMO);Streaming DEMO incluido;;;69900;',
    'Línea nueva;L1;Plan Nueva Línea (DEMO);20 GB;;SIM sin costo de envío (DEMO);;;;49900;',
  ].join('\n');

let db: TestDatabase;
let brainId: string;

beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await createPublishedCatalog(db.prisma, {
    name: DEFAULT_CATALOG_BRAIN,
    records: plans,
    actor: 'seed',
    action: 'BRAIN_SEEDED',
    note: 'prueba',
  });
  brainId = (await db.prisma.brain.findFirstOrThrow()).id;
});

const blobs = () => new PgBlobStore(db.prisma, cipher);

/** Lo que hace la API al recibir el archivo: blob cifrado + fuente PROCESSING. */
async function addSource(name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return db.prisma.knowledgeSource.create({
    data: {
      brainId,
      kind: 'FILE',
      use: 'CATALOG',
      name,
      mime: 'text/csv',
      sizeBytes: bytes.length,
      contentHash: sha256(Buffer.from(bytes)),
      blobRef: await blobs().put(bytes),
      createdBy: 'jefe',
    },
  });
}

const ingest = (sourceId: string) =>
  ingestSource(
    { prisma: db.prisma, blobs: blobs(), parser: new CatalogTableParser() },
    { sourceId, requestedBy: 'jefe' },
  );

async function publishDraft() {
  const draft = await db.prisma.brainVersion.findFirstOrThrow({
    where: { brainId, status: 'DRAFT' },
  });
  await db.prisma.brainVersion.update({ where: { id: draft.id }, data: { status: 'EVALUATING' } });
  return evaluateBrainVersion(
    {
      prisma: db.prisma,
      provider: 'anthropic',
      llm: () => new ScriptedLlmAdapter(heuristicBrain),
      logger,
    },
    { versionId: draft.id, requestedBy: 'jefe', kind: 'brain' },
  );
}

/** Conversación de portabilidad que termina con la ficha de P1 en pantalla. */
async function conversationShowingP1(catalog: PublishedBrainCatalog, chat: string) {
  const out = (o: Partial<TurnOutput>): TurnOutput => ({
    intent: 'DA_DATO',
    reply: 'Claro.',
    option: null,
    planCode: null,
    extracted: { name: null, currentOperator: null, usage: null },
    confidence: 'ALTA',
    ...o,
  });
  const llm = new ScriptedLlmAdapter((req: LlmRequest) =>
    /Etapa actual: PERFIL/.test(req.systemDynamic)
      ? out({
          reply: 'Te recomiendo:\n{{OFERTA:P1}}',
          extracted: { name: 'Ana', currentOperator: 'Tigo', usage: 'redes' },
        })
      : out({}),
  );
  const svc = new TurnService({
    store: new PrismaConversationStore(db.prisma, cipher),
    engine: new ConversationEngine({ llm, catalog }),
    catalog,
    alerts: { raise: async () => undefined },
    logger,
  });
  const conv = await db.prisma.conversation.create({
    data: { abayaChatId: chat, robotUser: 'robot' },
  });
  let n = 0;
  for (const text of ['Hola', 'A', 'Ana, de Tigo, uso redes']) {
    const fingerprint = `${chat}-${++n}`;
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
  }
  const last = await db.prisma.message.findFirstOrThrow({
    where: { conversationId: conv.id, direction: 'OUTBOUND' },
    orderBy: { occurredAt: 'desc' },
  });
  const usage = await db.prisma.knowledgeUsage.findFirstOrThrow({
    where: { conversationId: conv.id, rendered: { has: 'P1' } },
  });
  return {
    text: cipher.decryptString(last.bodyEncrypted, outboundAad(last.idempotencyKey!)),
    usage,
  };
}

describe('Brain de catálogo: del archivo a la conversación', () => {
  it('un cambio de precio pasa por borrador y evaluación, queda auditado y llega a la siguiente conversación', async () => {
    const catalog = new PublishedBrainCatalog(db.prisma, logger);
    await catalog.refresh();
    const before = await conversationShowingP1(catalog, 'CH-1');
    expect(before.text).toContain('$39.900');
    expect(before.usage.brainVersion).toBe(1);

    // 1. Nuevo archivo → borrador v2 con el diff; el agente sigue con la v1 publicada.
    const src = await addSource('planes-octubre.csv', csvWithP1('$ 42.900'));
    expect(await ingest(src.id)).toBe('READY');
    const draft = await db.prisma.brainVersion.findFirstOrThrow({
      where: { brainId, status: 'DRAFT' },
    });
    expect(draft.version).toBe(2);
    const diff = draft.diff as unknown as CatalogDiff;
    expect(diff.changed).toEqual([
      expect.objectContaining({
        code: 'P1',
        changes: [{ field: 'priceCop', label: 'Precio', before: 39900, after: 42900 }],
      }),
    ]);
    await catalog.refresh();
    expect((await catalog.query('PORTABILIDAD')).plans[0]!.priceCop).toBe(39900);

    // 2. Publicar = pasar la suite. La v1 queda archivada; auditoría con el diff; evento.
    expect(await publishDraft()).toBe('PUBLISHED');
    const versions = await db.prisma.brainVersion.findMany({
      where: { brainId },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'ARCHIVED'],
      [2, 'PUBLISHED'],
    ]);
    const audit = await db.prisma.adminAuditLog.findFirstOrThrow({
      where: { action: 'BRAIN_PUBLISHED' },
    });
    expect(audit.actor).toBe('jefe');
    expect(
      (audit.detail as unknown as { diff: CatalogDiff }).diff.changed[0]!.changes[0],
    ).toMatchObject({
      before: 39900,
      after: 42900,
    });
    expect(await db.prisma.outboxEvent.count({ where: { type: 'BrainVersionPublished' } })).toBe(2);

    // 3. La siguiente conversación ya muestra el precio publicado, citado literal.
    await catalog.refresh();
    const after = await conversationShowingP1(catalog, 'CH-2');
    expect(after.text).toContain('$42.900');
    expect(after.text).not.toContain('$39.900');
    expect(after.usage).toMatchObject({ brainVersion: 2, brainVersionId: versions[1]!.id });
  });

  it('archivo inválido: la fuente queda en ERROR con fila y columna, sin borrador', async () => {
    const src = await addSource('malo.csv', `${HEADER}\nPrepago;P1;X;10 GB;;;;;;99,9;\n`);
    expect(await ingest(src.id)).toBe('ERROR');
    const s = await db.prisma.knowledgeSource.findUniqueOrThrow({ where: { id: src.id } });
    expect(s.status).toBe('ERROR');
    expect(s.errorReason).toContain('Fila 2, Proceso: proceso desconocido «Prepago»');
    expect(s.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 2, column: 'Proceso' })]),
    );
    expect(await db.prisma.brainVersion.count({ where: { brainId, status: 'DRAFT' } })).toBe(0);
    expect(await db.prisma.outboxEvent.count({ where: { type: 'SourceFailed' } })).toBe(1);
  });

  it('un mismo ID en dos fuentes del Brain se rechaza (sería ambiguo el precio)', async () => {
    const a = await addSource('a.csv', csvWithP1('39900'));
    expect(await ingest(a.id)).toBe('READY');
    const b = await addSource('b.csv', `${HEADER}\nPortabilidad;P1;Otro;10 GB;;;;;;10000;\n`);
    expect(await ingest(b.id)).toBe('ERROR');
    expect(
      (await db.prisma.knowledgeSource.findUniqueOrThrow({ where: { id: b.id } })).errorReason,
    ).toContain('el ID P1 ya está en la fuente «a.csv»');
  });

  it('el mismo contenido que la versión publicada no crea borrador', async () => {
    const src = await addSource('igual.csv', csvWithP1('39900'));
    expect(await ingest(src.id)).toBe('READY');
    expect(await db.prisma.brainVersion.count({ where: { brainId } })).toBe(1);
  });

  it('revertir: un borrador copia de una versión anterior, que también se publica con la suite', async () => {
    const src = await addSource('octubre.csv', csvWithP1('42900'));
    await ingest(src.id);
    await publishDraft();
    const v1 = await db.prisma.brainVersion.findFirstOrThrow({ where: { brainId, version: 1 } });
    const restored = await replaceDraft(
      db.prisma,
      brainId,
      await versionContent(db.prisma, v1.id),
      'jefe',
      1,
    );
    expect(restored.version).toBe(3);
    expect(restored.diff.changed[0]!.changes[0]).toMatchObject({ before: 42900, after: 39900 });
    expect(await publishDraft()).toBe('PUBLISHED');
    const pub = await db.prisma.brainVersion.findFirstOrThrow({
      where: { brainId, status: 'PUBLISHED' },
    });
    expect(pub).toMatchObject({ version: 3, basedOn: 1 });
  });

  it('la suite rechaza un catálogo que deja un proceso sin planes', async () => {
    const onlyPorta = [HEADER, csvWithP1('39900').split('\n')[1]!].join('\n');
    const src = await addSource('solo-porta.csv', onlyPorta);
    await ingest(src.id);
    expect(await publishDraft()).toBe('REJECTED');
    const v = await db.prisma.brainVersion.findFirstOrThrow({ where: { brainId, version: 2 } });
    expect(v.status).toBe('REJECTED');
    expect((v.evalSummary as { problems: string[] }).problems.join()).toMatch(/correctos/);
    expect(await db.prisma.adminAuditLog.count({ where: { action: 'BRAIN_REJECTED' } })).toBe(1);
  });
});

describe('paso de v1.8 a v1.9', () => {
  it('el catálogo vigente de Plan pasa a ser la v1 publicada del Brain, una sola vez', async () => {
    await db.reset();
    await db.prisma.plan.createMany({
      data: [
        {
          code: 'P1',
          process: 'PORTABILIDAD',
          name: 'Porta',
          dataGb: 10,
          priceCop: 39900,
          benefits: ['Redes'],
          validFrom: new Date('2026-01-01'),
        },
        {
          code: 'L9',
          process: 'LINEA_NUEVA',
          name: 'Retirado',
          dataGb: 5,
          priceCop: 19900,
          benefits: [],
          active: false,
          validFrom: new Date('2025-01-01'),
        },
      ],
    });
    expect(await bootstrapLegacyCatalog(db.prisma)).toEqual({ created: true, records: 1 });
    expect(await bootstrapLegacyCatalog(db.prisma)).toEqual({ created: false, records: 0 });
    const catalog = new PublishedBrainCatalog(db.prisma, logger);
    await catalog.refresh();
    const q = await catalog.query('PORTABILIDAD');
    expect(q.plans).toEqual([
      expect.objectContaining({
        code: 'P1',
        dataText: '10 GB',
        includesText: 'Redes',
        priceCop: 39900,
      }),
    ]);
    expect((await catalog.query('LINEA_NUEVA')).status).toBe('SIN_PLANES');
    expect(await db.prisma.adminAuditLog.count({ where: { action: 'BRAIN_MIGRATED' } })).toBe(1);
  });
});
