// PRUEBA de la pestaña Trazabilidad (datos FICTICIOS). Crea el robot "robot-prueba" y 3
// conversaciones de hoy con desenlaces distintos, cifradas con la clave del .env como las guarda
// el worker. Borrar todo: node --env-file-if-exists=../../.env _prueba-trazabilidad.mjs --borrar
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@abaya/config';
import { GENESIS_HASH, chainHash, cipherFromConfig, sha256 } from '@abaya/crypto';
import { createPrismaClient } from '@abaya/db';
import { consentAad, inboundAad, outboundAad, profileAad, saleAad } from '@abaya/domain';
import { actionLogHashInput } from '@abaya/robot-store';

const ROBOT = 'robot-prueba';
const CHATS = ['PRUEBA-0001', 'PRUEBA-0002', 'PRUEBA-0003'];
const cfg = loadConfig();
const prisma = createPrismaClient(cfg.DATABASE_URL);
const cipher = cipherFromConfig(cfg);

async function borrar() {
  const ids = (
    await prisma.conversation.findMany({
      where: { abayaChatId: { in: CHATS } },
      select: { id: true },
    })
  ).map((c) => c.id);
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { conversationId: { in: ids } } }),
    prisma.llmCall.deleteMany({ where: { conversationId: { in: ids } } }),
    prisma.knowledgeUsage.deleteMany({ where: { conversationId: { in: ids } } }),
    prisma.consentEvidence.deleteMany({ where: { conversationId: { in: ids } } }),
    prisma.sale.deleteMany({ where: { conversationId: { in: ids } } }),
    prisma.$executeRawUnsafe(
      `DELETE FROM "OutboxEvent" WHERE payload->>'conversationId' = ANY($1)`,
      ids,
    ),
    prisma.conversation.deleteMany({ where: { id: { in: ids } } }),
    prisma.rpaActionLog.deleteMany({ where: { robotUser: ROBOT } }),
    prisma.rpaSession.deleteMany({ where: { robotUser: ROBOT } }),
    prisma.robot.deleteMany({ where: { robotUser: ROBOT } }),
  ]);
  console.log(`Prueba borrada (${ids.length} conversaciones y el robot ${ROBOT}).`);
}

if (process.argv.includes('--borrar')) {
  await borrar();
  await prisma.$disconnect();
  process.exit(0);
}
await borrar(); // re-ejecutable: parte de cero

// Catálogo publicado: los precios mostrados salen de aquí (regla 11).
const published = await prisma.brainVersion.findFirst({
  where: { status: 'PUBLISHED' },
  include: { records: true },
  orderBy: { publishedAt: 'desc' },
});
const plan = (process) =>
  published?.records.find((r) => r.process === process) ?? published?.records[0];
const cop = (n) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })
    .format(n)
    .replace(/\s/g, ' ');

await prisma.robot.create({
  data: { robotUser: ROBOT, host: 'PC-PRUEBA', state: 'STOPPED', createdBy: 'prueba' },
});

let lastAction = GENESIS_HASH;
async function action(chat, act, result, at, durationMs, traceRef = null) {
  const entry = {
    robotUser: ROBOT,
    action: act,
    abayaChatId: chat,
    result,
    durationMs,
    traceRef,
    createdAt: at,
  };
  const hash = chainHash(lastAction, actionLogHashInput(entry));
  await prisma.rpaActionLog.create({ data: { ...entry, prevHash: lastAction, hash } });
  lastAction = hash;
}

/**
 * turns: [{ client, bot, rt (ms de respuesta), stage (llamada al modelo o null = plantilla),
 *           result (OK|REGENERATED|FALLBACK), status (SENT_VERIFIED|UNCERTAIN), attempts, offer }]
 */
async function conversation({ chat, startMin, status, stage, profile, turns, after }) {
  const start = new Date(Date.now() - startMin * 60_000);
  const c = await prisma.conversation.create({
    data: { abayaChatId: chat, robotUser: ROBOT, status, stage, createdAt: start },
  });
  await prisma.conversation.update({
    where: { id: c.id },
    data: {
      profileEncrypted: new Uint8Array(cipher.encrypt(JSON.stringify(profile), profileAad(c.id))),
    },
  });
  let t = start.getTime();
  await action(chat, 'OPEN_CHAT', 'OK', new Date(t), 820);
  for (const turn of turns) {
    const fp = randomUUID();
    await prisma.message.create({
      data: {
        conversationId: c.id,
        direction: 'INBOUND',
        fingerprint: fp,
        bodyEncrypted: new Uint8Array(cipher.encrypt(turn.client, inboundAad(fp))),
        occurredAt: new Date((t += turn.wait ?? 45_000)),
        processedAt: new Date(t),
      },
    });
    if (!turn.bot) continue;
    const key = randomUUID();
    const sentAt = new Date(t + turn.rt);
    await prisma.message.create({
      data: {
        conversationId: c.id,
        direction: 'OUTBOUND',
        idempotencyKey: key,
        bodyEncrypted: new Uint8Array(cipher.encrypt(turn.bot, outboundAad(key))),
        status: turn.status ?? 'SENT_VERIFIED',
        attempts: turn.attempts ?? 1,
        occurredAt: new Date(t + 400),
        respondsToAt: new Date(t),
        sentAt,
      },
    });
    if (turn.stage) {
      await prisma.llmCall.create({
        data: {
          conversationId: c.id,
          stage: turn.stage,
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          promptVersionId: 'prueba',
          latencyMs: Math.round(turn.rt * 0.7),
          inputTokens: 1100,
          outputTokens: 190,
          validationResult: turn.result ?? 'OK',
          createdAt: new Date(t + 300),
        },
      });
    }
    if (turn.offer && published) {
      await prisma.knowledgeUsage.create({
        data: {
          conversationId: c.id,
          brainId: published.brainId,
          brainVersionId: published.id,
          brainVersion: published.version,
          kind: 'CATALOG',
          provided: published.records.map((r) => r.code),
          rendered: [turn.offer.code],
          createdAt: sentAt,
        },
      });
    }
    if (turn.status === 'UNCERTAIN') {
      await action(chat, 'SEND', 'UNCERTAIN', sentAt, 6_200);
    } else {
      if ((turn.attempts ?? 1) > 1)
        await action(chat, 'SEND', 'ERROR', new Date(sentAt.getTime() - 3_000), 2_900);
      await action(chat, 'SEND', 'OK', sentAt, 900 + (turn.rt % 600));
    }
    t = sentAt.getTime();
  }
  const end = await after(c, t);
  await prisma.$executeRawUnsafe(
    `UPDATE "Conversation" SET "updatedAt" = $1::timestamptz AT TIME ZONE 'UTC' WHERE id = $2`,
    new Date(end).toISOString(),
    c.id,
  );
  return c;
}

const MENU =
  '¡Hola! 👋 Soy Sofía, asesora virtual de *Claro Móvil*. ¿En qué te puedo ayudar?\n*A.* Pasarme a Claro con mi número\n*B.* Cambiar mi plan actual de Claro\n*C.* Una línea nueva\n*D.* Soporte o reclamos';
const ficha = (p) =>
  p ? `*${p.name ?? p.code}*\n• ${p.dataText}\n• *${cop(p.priceCop)}* al mes` : 'Plan del catálogo';

// 1) Venta: portabilidad con una objeción, autorización y transferencia al backoffice.
const p1 = plan('PORTABILIDAD');
await conversation({
  chat: CHATS[0],
  startMin: 95,
  status: 'TRANSFERRED_BACKOFFICE',
  stage: 'TRANSFERENCIA',
  profile: {
    name: 'Mariana Velásquez',
    process: 'PORTABILIDAD',
    currentOperator: 'Tigo',
    usage: 'Redes sociales y videollamadas',
    planCode: p1?.code,
  },
  turns: [
    { client: 'Hola buenas tardes', bot: MENU, rt: 1_700, stage: null },
    {
      client: 'A',
      bot: '¡Genial! 😊 ¿Con quién tengo el gusto y con qué operador estás hoy?',
      rt: 1_900,
      stage: 'PERFIL',
    },
    {
      client: 'Mariana, estoy con Tigo. Uso mucho redes sociales y videollamadas',
      bot: `Gracias, Mariana. Para tu uso te recomiendo:\n${ficha(p1)}\n¿Te gustaría quedarte con este plan?`,
      rt: 2_600,
      stage: 'OFERTA',
      offer: p1,
    },
    {
      client: 'uy no sé, en Tigo pago menos',
      bot: 'Te entiendo. Con Claro tienes la red con mayor cobertura del país y conservas tu número; el cambio no tiene costo y tarda 24 horas hábiles. ¿Quieres que te lo muestre otra vez?',
      rt: 3_400,
      stage: 'OBJECIONES',
      result: 'REGENERATED',
    },
    {
      client: 'dale, muéstramelo',
      bot: `Este es el plan para ti:\n${ficha(p1)}\n¿Lo tomamos?`,
      rt: 2_100,
      stage: 'OFERTA',
      offer: p1,
    },
    {
      client: 'sí, lo quiero',
      bot: 'Perfecto. Para continuar necesito tu autorización para el tratamiento de tus datos (Ley 1581). Si estás de acuerdo, responde *SÍ AUTORIZO*.',
      rt: 1_500,
      stage: null,
    },
    {
      client: 'SÍ AUTORIZO',
      bot: '¡Listo, Mariana! Tu autorización quedó registrada. Un asesor del backoffice completa la portabilidad y te contacta pronto. 🙌',
      rt: 1_800,
      stage: null,
    },
  ],
  after: async (c, t) => {
    const acceptedAt = new Date(t - 1_500);
    const last = await prisma.consentEvidence.findFirst({
      orderBy: { seq: 'desc' },
      select: { hash: true },
    });
    const prevHash = last?.hash ?? GENESIS_HASH;
    const reply = 'SÍ AUTORIZO';
    const hash = chainHash(prevHash, {
      conversationId: c.id,
      textShownHash: sha256('texto-legal-prueba'),
      templateVersion: 'v3',
      customerReplyHash: sha256(reply),
      acceptedAt: acceptedAt.toISOString(),
    });
    await prisma.consentEvidence.create({
      data: {
        conversationId: c.id,
        textShownHash: sha256('texto-legal-prueba'),
        templateVersion: 'v3',
        customerReplyEncrypted: new Uint8Array(cipher.encrypt(reply, consentAad(c.id))),
        acceptedAt,
        prevHash,
        hash,
      },
    });
    const transferredAt = new Date(t + 75_000);
    await prisma.sale.create({
      data: {
        conversationId: c.id,
        process: 'PORTABILIDAD',
        planCode: p1?.code ?? 'P1',
        catalogVersionId: published?.id ?? null,
        summaryEncrypted: new Uint8Array(
          cipher.encrypt(
            `Portabilidad desde Tigo. Cliente Mariana Velásquez, uso redes sociales y videollamadas. Acepta plan ${p1?.code}. Autorización Ley 1581 registrada.`,
            saleAad(c.id),
          ),
        ),
        transferredAt,
        backofficeNoteOk: true,
      },
    });
    await action(CHATS[0], 'NOTE', 'OK', new Date(t + 40_000), 1_100);
    await action(CHATS[0], 'TRANSFER', 'OK', transferredAt, 1_400);
    return t + 80_000;
  },
});

// 2) Sin venta: migración, el cliente no está interesado tras ver la oferta.
const p2 = plan('MIGRACION');
await conversation({
  chat: CHATS[1],
  startMin: 62,
  status: 'CLOSED_NO_SALE',
  stage: 'CIERRE_SIN_VENTA',
  profile: {
    name: 'Julián Cárdenas',
    process: 'MIGRACION',
    currentOperator: 'Claro',
    usage: 'Trabajo y correo',
  },
  turns: [
    { client: 'buenas', bot: MENU, rt: 1_300, stage: null },
    {
      client: 'B',
      bot: '¡Claro que sí! ¿Con quién hablo y para qué usas más tu línea?',
      rt: 2_000,
      stage: 'PERFIL',
    },
    {
      client: 'Julián, la uso para trabajo y correo',
      bot: `Gracias, Julián. Para ti tengo:\n${ficha(p2)}\n¿Te gustaría cambiarte a este plan?`,
      rt: 2_900,
      stage: 'OFERTA',
      offer: p2,
    },
    {
      client: 'no gracias, por ahora me quedo con el que tengo',
      bot: 'Entendido, Julián. Si más adelante quieres revisar opciones, aquí estaré. ¡Que tengas un excelente día! 👋',
      rt: 1_600,
      stage: null,
    },
  ],
  after: async (c, t) => {
    await prisma.outboxEvent.create({
      data: {
        type: 'ConversationClosed',
        payload: {
          conversationId: c.id,
          abayaChatId: CHATS[1],
          robotUser: ROBOT,
          reason: 'NO_SALE',
          afterMessageIds: [],
        },
        createdAt: new Date(t + 5_000),
        publishedAt: new Date(t + 6_000),
      },
    });
    await action(CHATS[1], 'CLOSE', 'OK', new Date(t + 8_000), 700);
    return t + 10_000;
  },
});

// 3) Revisión humana: línea nueva, un envío incierto y el proveedor del modelo falla (sigue abierta).
const p3 = plan('LINEA_NUEVA');
await conversation({
  chat: CHATS[2],
  startMin: 24,
  status: 'NEEDS_REVIEW',
  stage: 'OFERTA',
  profile: {
    name: 'Sofía Londoño',
    process: 'LINEA_NUEVA',
    currentOperator: 'Ninguno',
    usage: 'Para su hija: redes y música',
  },
  turns: [
    { client: 'Hola, quiero una línea nueva para mi hija', bot: MENU, rt: 1_400, stage: null },
    {
      client: 'C',
      bot: '¡Con gusto! ¿Cómo te llamas y para qué usará la línea?',
      rt: 2_200,
      stage: 'PERFIL',
    },
    {
      client: 'Sofía. Es para mi hija, la usa para redes y música',
      bot: `Gracias, Sofía. Te recomiendo:\n${ficha(p3)}\n¿Te sirve?`,
      rt: 6_800,
      stage: 'OFERTA',
      offer: p3,
      status: 'UNCERTAIN',
      attempts: 1,
    },
    { client: '¿y trae minutos para llamar a otros operadores?', wait: 90_000 },
  ],
  after: async (c, t) => {
    await prisma.llmCall.create({
      data: {
        conversationId: c.id,
        stage: 'OFERTA',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        promptVersionId: 'prueba',
        latencyMs: 30_000,
        inputTokens: 1200,
        outputTokens: 0,
        validationResult: 'FALLBACK',
        createdAt: new Date(t + 30_000),
      },
    });
    await prisma.outboxEvent.create({
      data: {
        type: 'NeedsReview',
        payload: {
          conversationId: c.id,
          reason: 'proveedor del modelo sin respuesta',
          robotUser: ROBOT,
        },
        createdAt: new Date(t + 31_000),
        publishedAt: new Date(t + 32_000),
      },
    });
    return Date.now();
  },
});

console.log(`Prueba creada: robot ${ROBOT}, chats ${CHATS.join(', ')}.`);
await prisma.$disconnect();
