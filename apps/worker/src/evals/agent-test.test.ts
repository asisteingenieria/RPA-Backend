import { DEFAULT_AGENT_CONFIG } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import { MemoryCatalog, readCatalogFile, SYNTHETIC_CATALOG } from '../catalog/catalog.js';
import * as T from '../engine/templates/templates.js';
import { heuristicBrain } from '../llm/adapters/heuristic-brain.js';
import { ScriptedLlmAdapter } from '../llm/adapters/scripted.adapter.js';
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
    expect(r.replies).toEqual([T.menu('¡Hola! Soy Sofía.')]);
    expect(r).toMatchObject({ stage: 'MENU', validation: 'NO_LLM', events: [] });
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
      'Transferencia al backoffice (con nota interna)',
    ]);
    expect(all.replies.at(-1)).toBe(T.TRANSFER);
  });

  it('opción D: soporte y cierre', async () => {
    const r = await runAgentTest(deps, {
      agent,
      state: { stage: 'MENU', profile: {}, history: [{ role: 'bot', text: T.MENU }] },
      message: 'D',
    });
    expect(r.stage).toBe('SOPORTE');
    expect(r.events).toEqual(['Chat cerrado (soporte *611)']);
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
