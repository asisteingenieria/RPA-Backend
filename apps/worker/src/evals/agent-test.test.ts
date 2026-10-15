import { DEFAULT_AGENT_CONFIG, DEFAULT_FLOW } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import { MemoryCatalog, readCatalogFile, SYNTHETIC_CATALOG } from '../catalog/catalog.js';
import * as T from '../engine/templates/templates.js';
import { heuristicBrain } from '../llm/adapters/heuristic-brain.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';
import { ScriptedSpeechAdapter } from '../speech/from-config.js';
import { runAgentTest } from './agent-test.js';

const catalog = new MemoryCatalog(await readCatalogFile(SYNTHETIC_CATALOG));
const agent = { ...DEFAULT_AGENT_CONFIG, welcome: '¡Hola! Soy Sofía.' };
const deps = { llm: new ScriptedLlmAdapter(heuristicBrain), catalog };

describe('probar agente (turno simulado)', () => {
  it('el primer mensaje recibe la bienvenida configurada y el menú', async () => {
    const r = await runAgentTest(deps, {
      agent,
      state: { stage: 'MENU', profile: {}, history: [] },
      message: 'Hola',
    });
    expect(r.replies).toEqual([T.menu({ welcome: '¡Hola! Soy Sofía.', flow: DEFAULT_FLOW })]);
    expect(r).toMatchObject({ stage: 'MENU', validation: 'NO_LLM', events: [] });
  });

  it('D-017: el robot abre la conversación con el saludo, sin mensaje del cliente', async () => {
    const r = await runAgentTest(deps, {
      agent,
      state: { stage: 'MENU', profile: {}, history: [] },
      message: '',
      opening: true,
    });
    expect(r.replies).toEqual([T.menu({ welcome: '¡Hola! Soy Sofía.', flow: DEFAULT_FLOW })]);
    expect(r).toMatchObject({ stage: 'MENU', validation: 'NO_LLM', llm: [] });
    // Ya abierta, no se repite.
    const again = await runAgentTest(deps, {
      agent,
      state: { stage: 'MENU', profile: {}, history: [{ role: 'bot', text: r.replies[0]! }] },
      message: '',
      opening: true,
    });
    expect(again.replies).toEqual([]);
  });

  it('13/10/2026: tras el «SÍ», un dato parcial no tiene respuesta: espera los demás', async () => {
    const r = await runAgentTest(deps, {
      agent,
      state: {
        stage: 'AUTORIZACION',
        profile: { process: 'MIGRACION', usage: 'redes', planCode: 'M1', dataRequested: true },
        history: [{ role: 'bot', text: 'pide datos' }],
      },
      message: '1234569',
    });
    expect(r.replies).toEqual([]);
    expect(r.events[0]).toContain('espera el resto de los datos');
    expect(r.profile.saleDocument).toBe('1234569');
    expect(r.stage).toBe('AUTORIZACION');
  });

  it('una conversación completa termina en transferencia con consentimiento', async () => {
    let state = { stage: 'MENU' as string, profile: {}, history: [] as never[] } as Parameters<
      typeof runAgentTest
    >[1]['state'];
    const all: { replies: string[]; events: string[] } = { replies: [], events: [] };
    for (const msg of [
      'Hola',
      'B',
      'soy Ana',
      'uso redes y videos',
      'sí, quiero ese plan',
      'SÍ AUTORIZO',
      '1000000000 Ana Demo ana@ejemplo.test', // D-013: los datos que pide tras el «SÍ»
    ]) {
      const r = await runAgentTest(deps, { agent, state, message: msg });
      all.replies.push(...r.replies);
      all.events.push(...r.events);
      state = {
        stage: r.stage,
        profile: r.profile,
        history: [
          ...state.history,
          { role: 'customer', text: msg },
          ...r.replies.map((t) => ({ role: 'bot' as const, text: t })),
        ],
      };
    }
    expect(state.stage).toBe('TRANSFERENCIA');
    expect(all.events).toEqual([
      'Consentimiento registrado (evidencia con cadena de hashes)',
      'Finalizar en Abaya: la venta pasa a la cola de backoffice',
    ]);
    expect(all.replies.at(-1)).toContain('Te transfiero con uno de nuestros asesores');
  });

  it('opción D: pregunta qué necesita sin cerrar; «no gracias» cierra como soporte', async () => {
    const menu = {
      stage: 'MENU' as const,
      profile: {},
      history: [{ role: 'bot' as const, text: T.MENU }],
    };
    const r = await runAgentTest(deps, { agent, state: menu, message: 'D' });
    expect(r.stage).toBe('MENU');
    expect(r.replies).toEqual([T.ASK_NEED]);
    expect(r.profile.needAsked).toBe(true);
    expect(r.events).toEqual([]);
    const r2 = await runAgentTest(deps, {
      agent,
      state: {
        stage: r.stage,
        profile: r.profile,
        history: [...menu.history, { role: 'customer', text: 'D' }],
      },
      message: 'no gracias',
    });
    expect(r2.stage).toBe('SOPORTE');
    expect(r2.events).toEqual(['Chat cerrado (soporte *611) · tipificación por defecto']);
  });
});

describe('chequeo de precios de la suite (v1.9)', () => {
  it('pricesIn reconoce los precios de la ficha', async () => {
    const { pricesIn } = await import('./suite.js');
    expect(pricesIn('• Valor: *$39.900* al mes y $ 1.099.900 o $500')).toEqual([
      '$39.900',
      '$1.099.900',
      '$500',
    ]);
    expect(pricesIn('sin precios, 10 GB')).toEqual([]);
  });
});

describe('D-010: probar agente con nota de voz', () => {
  const voiceDeps = { ...deps, speech: new ScriptedSpeechAdapter() };
  const audio = (said: string, durationSec: number | null = 5) => ({
    data: Buffer.from(said, 'utf8').toString('base64'),
    mimeType: 'audio/wav',
    durationSec,
  });

  it('transcribe, responde según lo que dijo y devuelve el texto para el historial', async () => {
    const r = await runAgentTest(voiceDeps, {
      agent,
      state: { stage: 'MENU', profile: {}, history: [] },
      message: '',
      audio: audio('Hola'),
    });
    expect(r.heard).toMatchObject({ status: 'OK', transcript: 'Hola' });
    expect(r.customerText).toBe('[nota de voz] Hola');
    expect(r.replies).toEqual([T.menu({ welcome: '¡Hola! Soy Sofía.', flow: DEFAULT_FLOW })]);
  });

  it('no se entiende, muy larga o sin proveedor: plantilla para que escriba', async () => {
    const state = { stage: 'PERFIL', profile: { process: 'MIGRACION' }, history: [] } as never;
    const unclear = await runAgentTest(voiceDeps, { agent, state, message: '', audio: audio('~') });
    expect(unclear.heard?.status).toBe('UNINTELLIGIBLE');
    expect(unclear.replies).toEqual([T.VOICE_UNREADABLE]);
    expect(unclear.stage).toBe('PERFIL');

    const long = await runAgentTest(voiceDeps, {
      agent,
      state,
      message: '',
      audio: audio('soy Ana', 600),
    });
    expect(long.heard?.status).toBe('TOO_LONG');

    const none = await runAgentTest(deps, { agent, state, message: '', audio: audio('soy Ana') });
    expect(none.heard?.status).toBe('FAILED');
    expect(none.replies).toEqual([T.VOICE_UNREADABLE]);
  });
});
