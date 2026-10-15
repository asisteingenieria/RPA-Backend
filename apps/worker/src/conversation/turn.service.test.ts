import { DEFAULT_AGENT_CONFIG, LlmProviderError, type LlmRequest } from '@abaya/domain';
import { sha256 } from '@abaya/crypto';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import { recordsFromImages } from '@abaya/knowledge';
import { MemoryCatalog, readCatalogFile, SYNTHETIC_CATALOG } from '../catalog/catalog.js';
import { ConversationEngine } from '../engine/conversation-engine.js';
import type { TurnOutput } from '../engine/output-schema.js';
import * as T from '../engine/templates/templates.js';
import { heuristicBrain } from '../llm/adapters/heuristic-brain.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';
import { ScriptedSpeechAdapter } from '../speech/from-config.js';
import { VOICE_PREFIX } from '../engine/voice.js';
import { MemoryConversationStore } from './memory.store.js';
import { MemoryRobotsPause } from './robots-pause.js';
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
  extracted: { name: null, currentOperator: null, lineType: null, usage: null },
  tipificacion: null,
  confidence: 'ALTA',
  ...over,
});

/**
 * LLM simulado "razonable": decide por el estado que trae el prompt dinámico y el último
 * mensaje del cliente. Sirve para probar la integración, no la calidad del modelo.
 */
function fakeBrain(req: LlmRequest): TurnOutput {
  const last = req.messages.at(-1)!.content.toLowerCase().replaceAll(VOICE_PREFIX, '');
  const stage = /Etapa actual: (\w+)/.exec(req.systemDynamic)?.[1];
  if (stage === 'PERFIL') {
    if (last.startsWith('soy '))
      return base({
        intent: 'DA_DATO',
        reply: '¡Gracias! ¿Qué operador tienes hoy?',
        extracted: { name: last.slice(4), currentOperator: null, lineType: null, usage: null },
      });
    if (last.startsWith('tengo '))
      return base({
        intent: 'DA_DATO',
        reply: '¿Y cómo usas más tu celular?',
        extracted: { name: null, currentOperator: last.slice(6), lineType: null, usage: null },
      });
    return base({
      intent: 'DA_DATO',
      reply: 'Te recomiendo:\n{{OFERTA:P2}}\n¿Lo tomamos?',
      extracted: { name: null, currentOperator: null, lineType: null, usage: last },
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

describe('13/10/2026: datos tras el «SÍ»: espera en silencio y recuerda solo lo que falta', () => {
  function setupData() {
    const store = new MemoryConversationStore();
    let clock = Date.now();
    const later: { id: string; ms: number }[] = [];
    const svc = new TurnService({
      store,
      engine: new ConversationEngine({ llm: new ScriptedLlmAdapter([]), catalog }),
      catalog,
      alerts,
      logger: silent,
      now: () => new Date(clock),
      later: (id, ms) => void later.push({ id, ms }),
    });
    store.create('d1');
    const c = store.get('d1');
    c.stage = 'AUTORIZACION';
    c.status = 'WAITING_CONSENT';
    c.profile = { process: 'MIGRACION', usage: 'redes', planCode: 'M1', dataRequested: true };
    return { store, svc, later, wait: (s: number) => (clock += s * 1000) };
  }

  it('dato parcial: no responde; si el cliente no escribe más, le recuerda solo lo que falta', async () => {
    const { store, svc, later, wait } = setupData();
    store.addInbound('d1', '1234569');
    await svc.handle('d1');
    expect(store.outboundTexts('d1')).toEqual([]);
    expect(later).toEqual([{ id: 'd1', ms: expect.any(Number) }]);
    expect(later[0]!.ms).toBeGreaterThan(40_000);
    // Pasa la espera (45 s por defecto) sin que el cliente escriba: ahora sí, el recordatorio.
    wait(46);
    await svc.handle('d1');
    expect(store.outboundTexts('d1')).toEqual([
      '¡Gracias! Para finalizar tu solicitud me falta tu nombre completo y tu correo electrónico. ¿Me lo compartes, por favor?',
    ]);
  });

  it('datos en varios mensajes seguidos: un solo turno y transfiere sin recordatorios', async () => {
    const { store, svc, later } = setupData();
    store.addInbound('d1', '1234569');
    await svc.handle('d1');
    store.addInbound('d1', 'sebastian Acosta');
    await svc.handle('d1');
    expect(store.outboundTexts('d1')).toEqual([]);
    expect(later).toHaveLength(2);
    store.addInbound('d1', 'juan@gmail.com');
    await svc.handle('d1');
    expect(store.get('d1').stage).toBe('TRANSFERENCIA');
    expect(store.outboundTexts('d1')).toEqual([
      '¡Gracias, Sebastian! Te transfiero con uno de nuestros asesores para finalizar tu solicitud. 🚀',
    ]);
  });

  it('si escribe algo que no es un dato, responde de una vez con lo que falta', async () => {
    const { store, svc, later } = setupData();
    store.addInbound('d1', '¿para qué necesitan eso?');
    await svc.handle('d1');
    expect(later).toEqual([]);
    expect(store.outboundTexts('d1')[0]).toContain('me falta tu número de documento de identidad');
  });
});

describe('D-018: amenaza del cliente', () => {
  it('alerta a supervisores solo con el id de la conversación; la conversación sigue', async () => {
    alerts.raised.length = 0;
    const raisedWith: unknown[] = [];
    const spy = {
      async raise(code: string, _sev: string, ctx: unknown) {
        alerts.raised.push(code);
        raisedWith.push(ctx);
      },
    };
    const store = new MemoryConversationStore();
    const engine = new ConversationEngine({
      llm: new ScriptedLlmAdapter([
        base({ reply: 'Así no puedo ayudarte. ¿Seguimos con tu plan?' }),
      ]),
      catalog,
    });
    const svc = new TurnService({ store, engine, catalog, alerts: spy, logger: silent });
    store.create('t1');
    await say(store, svc, 't1', 'Hola');
    await say(store, svc, 't1', 'les voy a poner una bomba');
    expect(alerts.raised).toEqual(['CUSTOMER_THREAT']);
    expect(raisedWith).toEqual([{ conversationId: 't1' }]);
    expect(store.get('t1').status).toBe('ACTIVE');
    expect(store.outboundTexts('t1').at(-1)).toBe('Así no puedo ayudarte. ¿Seguimos con tu plan?');
  });
});

describe('D-017: el robot abre la conversación al recibir el caso', () => {
  it('sin mensajes por responder: saludo con el menú, sin llamar al modelo', async () => {
    const llm = new ScriptedLlmAdapter([]);
    const store = new MemoryConversationStore();
    const svc = new TurnService({
      store,
      engine: new ConversationEngine({ llm, catalog }),
      catalog,
      alerts,
      logger: silent,
    });
    store.create('c1');
    await svc.handle('c1');
    expect(store.outboundTexts('c1')).toEqual([T.MENU]);
    expect(store.events.map((e) => e.type)).toEqual(['ReplyReady']);
    expect(llm.requests).toHaveLength(0);
    // No se reabre: el robot ya habló.
    await svc.handle('c1');
    expect(store.outboundTexts('c1')).toEqual([T.MENU]);
  });

  it('lo que el cliente le escribió antes al bot de ySocial lo atiende el saludo (aunque sea una opción)', async () => {
    const { store, svc } = setup();
    store.create('c2');
    await say(store, svc, 'c2', 'A');
    expect(store.outboundTexts('c2')).toEqual([T.MENU]);
    expect(store.get('c2').stage).toBe('MENU');
    // Después del saludo, la opción sí cuenta.
    await say(store, svc, 'c2', 'A');
    expect(store.get('c2').stage).toBe('PERFIL');
  });

  it('con los robots pausados no abre (se abre cuando el cliente escriba o al reanudar)', async () => {
    const store = new MemoryConversationStore();
    const pause = new MemoryRobotsPause();
    await pause.pauseAll('MANUAL', 'prueba');
    const svc = new TurnService({
      store,
      engine: new ConversationEngine({ llm: new ScriptedLlmAdapter([]), catalog }),
      catalog,
      alerts,
      logger: silent,
      pause,
    });
    store.create('c3');
    await svc.handle('c3');
    expect(store.outboundTexts('c3')).toEqual([]);
  });
});

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

    // D-013: con el «SÍ» queda la venta y la evidencia, y se le piden los datos (como el asesor).
    expect(store.get('c1').stage).toBe('AUTORIZACION');
    expect(store.get('c1').status).toBe('WAITING_CONSENT');
    expect(store.sales).toEqual([
      expect.objectContaining({ process: 'PORTABILIDAD', planCode: 'P2' }),
    ]);
    expect(store.sales[0]!.summary).toContain('Cliente: ana');
    expect(store.sales[0]!.summary).toContain('Operador actual: operadorx');
    // La evidencia apunta al texto legal exacto que se envió al cliente.
    const legal = T.authorizationFor(
      DEFAULT_AGENT_CONFIG,
      new Date(store.get('c1').profile.authorizationShownAt!),
    );
    expect(store.outboundTexts('c1').some((t) => t.includes(legal.text))).toBe(true);
    expect(store.consents[0]).toMatchObject({
      textShownHash: sha256(legal.text),
      templateVersion: legal.version,
    });
    expect(store.outboundTexts('c1').at(-1)).toContain('número de documento de identidad');
    expect(store.events.slice(-2).map((e) => e.type)).toEqual(['ReplyReady', 'SaleCompleted']);

    await say(store, svc, 'c1', '1000000000 Ana Demo ana@ejemplo.test');
    const c = store.get('c1');
    expect(c.stage).toBe('TRANSFERENCIA');
    expect(c.status).toBe('TRANSFERRING');
    expect(store.sales).toHaveLength(1);

    // El último turno: despedida → transferencia (después de la despedida).
    const lastTurn = store.events.slice(-2);
    expect(lastTurn.map((e) => e.type)).toEqual(['ReplyReady', 'TransferRequested']);
    expect(lastTurn[1]!.payload).toMatchObject({
      target: 'BACKOFFICE',
      afterMessageIds: [lastTurn[0]!.payload.messageId],
    });
    expect(store.outboundTexts('c1').at(-1)).toContain(
      'Te transfiero con uno de nuestros asesores',
    );
    // Ningún mensaje enviado contiene un marcador sin reemplazar.
    expect(store.outboundTexts('c1').join('\n')).not.toContain('{{');
  });

  it('soporte: plantilla y cierre', async () => {
    const { store, svc } = setup();
    store.create('c2');
    await say(store, svc, 'c2', 'Hola');
    await say(store, svc, 'c2', 'D');
    // D-003: los canales de soporte no cierran el chat; cierra si no quiere un plan.
    expect(store.get('c2').status).toBe('ACTIVE');
    await say(store, svc, 'c2', 'no gracias');
    expect(store.get('c2').status).toBe('CLOSED_SUPPORT');
    expect(store.events.at(-1)).toMatchObject({
      type: 'ConversationClosed',
      payload: { reason: 'SUPPORT' },
    });
  });

  it('D-025: el cierre lleva la tipificación que eligió el modelo según la conversación', async () => {
    // El cerebro de línea base tipifica por palabras clave (el modelo real lee la conversación).
    const store = new MemoryConversationStore();
    const engine = new ConversationEngine({ llm: new ScriptedLlmAdapter(heuristicBrain), catalog });
    const svc = new TurnService({ store, engine, catalog, alerts, logger: silent });
    store.create('c-tip');
    await say(store, svc, 'c-tip', 'Hola');
    await say(store, svc, 'c-tip', 'C');
    await say(store, svc, 'c-tip', 'tengo una duda con mi factura');
    await say(store, svc, 'c-tip', 'no gracias');
    expect(store.get('c-tip').status).toBe('CLOSED_SUPPORT');
    expect(store.events.at(-1)).toMatchObject({
      type: 'ConversationClosed',
      payload: { reason: 'SUPPORT', tag: 'SAC_FACTURACION' },
    });
  });

  it('mensajes tras el cierre no generan turno', async () => {
    const { store, svc } = setup();
    store.create('c3');
    await say(store, svc, 'c3', 'Hola');
    await say(store, svc, 'c3', 'D');
    await say(store, svc, 'c3', 'no');
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
      // D-013: los datos que pide el asesor tras el «SÍ» (documento, nombre completo y correo).
      `10000000${String(i).padStart(2, '0')} Cliente Prueba cliente${i}@ejemplo.test`,
    ];
    for (let step = 0; step < 8; step++) {
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

describe('D-004: versión del agente por conversación', () => {
  it('una conversación nueva toma la publicada y la conserva aunque se publique otra', async () => {
    const store = new MemoryConversationStore();
    let published = DEFAULT_AGENT_CONFIG;
    const used: string[] = [];
    const v2 = { ...DEFAULT_AGENT_CONFIG, id: 'v2', version: 2, welcome: '¡Hola desde v2!' };
    const v3 = { ...DEFAULT_AGENT_CONFIG, id: 'v3', version: 3, welcome: '¡Hola desde v3!' };
    const byId = new Map([v2, v3].map((v) => [v.id, v]));
    const engine = new ConversationEngine({
      llm: new ScriptedLlmAdapter(fakeBrain),
      catalog,
      agentConfig: (s) => {
        const a = (s.agentVersionId && byId.get(s.agentVersionId)) || published;
        used.push(a.id);
        return a;
      },
    });
    const svc = new TurnService({
      store,
      engine,
      catalog,
      alerts,
      logger: silent,
      currentAgentVersionId: () => published.id,
    });

    published = v2;
    store.create('c1');
    await say(store, svc, 'c1', 'Hola');
    expect(store.get('c1').agentVersionId).toBe('v2');
    expect(store.outboundTexts('c1')[0]).toContain('¡Hola desde v2!');

    // Se publica la v3: la conversación en curso sigue con la v2; una nueva empieza con la v3.
    published = v3;
    await say(store, svc, 'c1', 'A');
    expect(store.get('c1').agentVersionId).toBe('v2');
    store.create('c2');
    await say(store, svc, 'c2', 'Hola');
    expect(store.get('c2').agentVersionId).toBe('v3');
    expect(store.outboundTexts('c2')[0]).toContain('¡Hola desde v3!');
    expect(used).toEqual(['v2', 'v2', 'v3']);
  });
});

describe('D-009: el proveedor de LLM no responde', () => {
  it('pausa todos los robots sin perder ni responder nada; al reanudar, contesta', async () => {
    const store = new MemoryConversationStore();
    let down = false;
    let calls = 0;
    const llm = {
      provider: 'scripted',
      async complete(req: LlmRequest) {
        calls++;
        if (down) throw new LlmProviderError('gemini 429', 'scripted', true);
        return { json: fakeBrain(req), model: 'm', latencyMs: 1, inputTokens: 1, outputTokens: 1 };
      },
    };
    const engine = new ConversationEngine({ llm, catalog });
    const pause = new MemoryRobotsPause();
    const raised: string[] = [];
    const svc = new TurnService({
      store,
      engine,
      catalog,
      alerts: { raise: async (code) => void raised.push(code) },
      logger: silent,
      pause,
    });
    store.create('o1');
    await say(store, svc, 'o1', 'Hola');
    await say(store, svc, 'o1', 'A');
    await say(store, svc, 'o1', 'soy Ana');
    const sentBefore = store.outboundTexts('o1').length;

    // Primer mensaje con el LLM caído: nada se envía, el mensaje queda pendiente.
    calls = 0;
    down = true;
    await say(store, svc, 'o1', 'tengo OperadorX');
    expect(pause.paused).toBe(true);
    expect(pause.reason).toMatchObject({ cause: 'LLM_OUTAGE' });
    expect(raised).toContain('LLM_OUTAGE');
    expect(store.outboundTexts('o1').length).toBe(sentBefore);
    expect(store.get('o1').status).toBe('ACTIVE');
    const pending = () =>
      store.get('o1').messages.filter((m) => m.direction === 'INBOUND' && !m.processed).length;
    expect(pending()).toBe(1);

    // Pausados: otro mensaje no llama al modelo.
    down = false;
    calls = 0;
    await say(store, svc, 'o1', '¿hola?');
    expect(calls).toBe(0);
    expect(pending()).toBe(2);

    // Un ADMIN reanuda: los dos mensajes se atienden en un solo turno.
    pause.paused = false;
    await svc.handle('o1');
    expect(pending()).toBe(0);
    expect(store.outboundTexts('o1').length).toBeGreaterThan(sentBefore);
  });
});

describe('D-010: notas de voz', () => {
  function voiceSetup(speech: ConstructorParameters<typeof TurnService>[0]['speech']) {
    const store = new MemoryConversationStore();
    const seen: string[] = [];
    const llm = new ScriptedLlmAdapter((req) => {
      seen.push(req.messages.at(-1)!.content);
      return fakeBrain(req);
    });
    const engine = new ConversationEngine({ llm, catalog });
    const pause = new MemoryRobotsPause();
    const raised: string[] = [];
    const svc = new TurnService({
      store,
      engine,
      catalog,
      alerts: { raise: async (code) => void raised.push(code) },
      logger: silent,
      pause,
      speech,
    });
    return { store, svc, seen, pause, raised };
  }
  const voice = (store: MemoryConversationStore, id: string, said: string, sec = 8) =>
    store.addVoice(id, Buffer.from(said, 'utf8'), sec);

  async function toOffer(store: MemoryConversationStore, svc: TurnService, id: string) {
    store.create(id);
    await say(store, svc, id, 'Hola');
    await say(store, svc, id, 'A');
  }

  it('transcribe, el motor recibe el texto marcado y el audio se borra', async () => {
    const { store, svc, seen } = voiceSetup(new ScriptedSpeechAdapter());
    await toOffer(store, svc, 'v1');
    const msgId = voice(store, 'v1', 'soy Ana');
    await svc.handle('v1');
    expect(seen.at(-1)).toBe(`${VOICE_PREFIX}soy Ana`);
    expect(store.get('v1').profile.name).toBe('ana');
    const m = store.get('v1').messages.find((x) => x.id === msgId)!;
    expect(m).toMatchObject({ text: 'soy Ana', processed: true });
    expect(m.voice).toMatchObject({ status: 'OK', audio: null });
  });

  it('solo notas que no se entienden: plantilla para que escriba, sin llamar al modelo', async () => {
    const { store, svc, seen } = voiceSetup(new ScriptedSpeechAdapter());
    await toOffer(store, svc, 'v2');
    const calls = seen.length;
    voice(store, 'v2', '~ruido');
    await svc.handle('v2');
    expect(seen.length).toBe(calls);
    expect(store.outboundTexts('v2').at(-1)).toBe(T.VOICE_UNREADABLE);
    expect(store.get('v2').stage).toBe('PERFIL');
    expect(store.get('v2').messages.every((m) => m.processed)).toBe(true);
  });

  it('muy larga o sin proveedor: no se transcribe y se pide escribir', async () => {
    const long = voiceSetup(new ScriptedSpeechAdapter());
    await toOffer(long.store, long.svc, 'v3');
    const id = voice(long.store, 'v3', 'soy Ana', 600);
    await long.svc.handle('v3');
    expect(long.store.get('v3').messages.find((m) => m.id === id)!.voice?.status).toBe('TOO_LONG');
    expect(long.store.outboundTexts('v3').at(-1)).toBe(T.VOICE_UNREADABLE);

    const none = voiceSetup(null);
    await toOffer(none.store, none.svc, 'v4');
    voice(none.store, 'v4', 'soy Ana');
    await none.svc.handle('v4');
    expect(none.store.outboundTexts('v4').at(-1)).toBe(T.VOICE_UNREADABLE);
  });

  it('nota de voz que el robot no descargó («[audio]»): pide escribir, sin llamar al modelo', async () => {
    // 15/10/2026: en ySocial real el robot aún no descarga las notas: llegan como «[audio]».
    const { store, svc, seen } = voiceSetup(new ScriptedSpeechAdapter());
    await toOffer(store, svc, 'v7');
    const calls = seen.length;
    store.addInbound('v7', '[audio]');
    await svc.handle('v7');
    expect(seen.length).toBe(calls);
    expect(store.outboundTexts('v7').at(-1)).toBe(T.VOICE_UNREADABLE);
    expect(T.VOICE_UNREADABLE).toContain('escribes tu solicitud en texto');
    expect(store.get('v7').stage).toBe('PERFIL');
  });

  it('texto + nota que no se entiende: responde el texto y avisa de la nota', async () => {
    const { store, svc } = voiceSetup(new ScriptedSpeechAdapter());
    await toOffer(store, svc, 'v5');
    voice(store, 'v5', '~');
    store.addInbound('v5', 'soy Ana');
    await svc.handle('v5');
    expect(store.get('v5').profile.name).toBe('ana');
    expect(store.outboundTexts('v5').at(-1)).toBe(T.VOICE_UNREADABLE);
  });

  it('«sí autorizo» por nota de voz no es consentimiento: se pide por escrito', async () => {
    const { store, svc } = voiceSetup(new ScriptedSpeechAdapter());
    await toOffer(store, svc, 'v6');
    await say(store, svc, 'v6', 'soy Ana');
    await say(store, svc, 'v6', 'tengo OperadorX');
    await say(store, svc, 'v6', 'videos y redes');
    await say(store, svc, 'v6', 'quiero ese plan');
    expect(store.get('v6').stage).toBe('AUTORIZACION');
    voice(store, 'v6', 'Sí, sí autorizo');
    await svc.handle('v6');
    expect(store.get('v6').stage).toBe('AUTORIZACION');
    expect(store.sales).toHaveLength(0);
    expect(store.consents).toHaveLength(0);
    expect(store.outboundTexts('v6').at(-1)).toBe(T.CONSENT_IN_WRITING);
    await say(store, svc, 'v6', 'SI');
    expect(store.get('v6').profile.dataRequested).toBe(true);
    expect(store.consents[0]).toMatchObject({ customerReply: 'SI' });
  });

  it('el servicio de voz no responde: pausa como D-009 y la nota sigue esperando', async () => {
    let down = true;
    const scripted = new ScriptedSpeechAdapter();
    const speech = {
      provider: 'scripted',
      async transcribe(req: Parameters<ScriptedSpeechAdapter['transcribe']>[0]) {
        if (down) throw new LlmProviderError('gemini 429', 'scripted', true);
        return scripted.transcribe(req);
      },
    };
    const { store, svc, pause, raised } = voiceSetup(speech);
    await toOffer(store, svc, 'v7');
    const sent = store.outboundTexts('v7').length;
    const id = voice(store, 'v7', 'soy Ana');
    await svc.handle('v7');
    expect(pause.paused).toBe(true);
    expect(raised).toContain('LLM_OUTAGE');
    expect(store.outboundTexts('v7').length).toBe(sent);
    const m = () => store.get('v7').messages.find((x) => x.id === id)!;
    expect(m().voice).toMatchObject({ status: 'PENDING' });
    expect(m().voice?.audio).not.toBeNull();

    down = false;
    pause.paused = false;
    await svc.handle('v7');
    expect(m().voice?.status).toBe('OK');
    expect(store.get('v7').profile.name).toBe('ana');
  });
});

describe('D-014 fase 2: oferta con imágenes en conversaciones reales', () => {
  const SOURCE = { brainId: 'b2', brainName: 'Planes Agosto', versionId: 'v9', version: 9 };
  const imgs = [
    {
      id: 'vi-alto',
      sourceName: 'portabilidad-1.png',
      sourceHash: 'h1',
      blobRef: 'blob-1',
      mime: 'image/png',
      sizeBytes: 1000,
      processes: ['PORTABILIDAD' as const],
      ord: 0,
      cards: [{ code: '37230', dataText: 'GB ILIMITADAS', priceCop: 99_900 }],
    },
  ];
  const fromImages = new MemoryCatalog(recordsFromImages(imgs), SOURCE, imgs);

  it('el mensaje saliente lleva la imagen y el texto del modelo como pie de foto', async () => {
    const store = new MemoryConversationStore();
    const engine = new ConversationEngine({
      llm: new ScriptedLlmAdapter([
        base({
          intent: 'DA_DATO',
          reply: 'Por el proceso de cambio de operador te puedo otorgar esta opción: {{IMAGENES}}',
          extracted: { name: null, currentOperator: null, lineType: null, usage: 'redes' },
        }),
      ]),
      catalog: fromImages,
      offerWithImages: true,
    });
    const svc = new TurnService({ store, engine, catalog: fromImages, alerts, logger: silent });
    store.create('c9');
    const c = store.get('c9');
    c.stage = 'PERFIL';
    c.profile = { process: 'PORTABILIDAD', name: 'Ana', currentOperator: 'Tigo' };
    await say(store, svc, 'c9', 'uso mucho redes');
    const out = c.messages.filter((m) => m.direction === 'OUTBOUND');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      text: 'Por el proceso de cambio de operador te puedo otorgar esta opción:',
      imageId: 'vi-alto',
    });
    expect(c.stage).toBe('OFERTA');
  });
});
