import { readFileSync } from 'node:fs';
import { LlmProviderError } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import { MemoryCatalog, catalogFileSchema } from '../catalog/catalog.js';
import { ScriptedLlmAdapter, type ScriptStep } from '../llm/adapters/scripted.adapter.js';
import { ConversationEngine } from './conversation-engine.js';
import type { TurnOutput } from './output-schema.js';
import * as T from './templates/templates.js';
import type { ConversationState } from './types.js';

const catalog = new MemoryCatalog(
  catalogFileSchema.parse(
    JSON.parse(readFileSync(new URL('../catalog/plans.synthetic.json', import.meta.url), 'utf8')),
  ).plans,
);
const NOW = new Date('2026-10-05T15:00:00Z');

const out = (over: Partial<TurnOutput> = {}): TurnOutput => ({
  intent: 'PREGUNTA',
  reply: 'Con gusto te cuento.',
  option: null,
  planCode: null,
  extracted: { name: null, currentOperator: null, usage: null },
  confidence: 'ALTA',
  ...over,
});

function engine(steps: ScriptStep[]) {
  const llm = new ScriptedLlmAdapter(steps);
  return { llm, e: new ConversationEngine({ llm, catalog, now: () => NOW }) };
}

const state = (over: Partial<ConversationState> = {}): ConversationState => ({
  conversationId: 'c1',
  stage: 'MENU',
  profile: {},
  history: [{ role: 'bot', text: T.MENU }],
  ...over,
});

const sent = (r: { actions: { type: string }[] }) =>
  r.actions
    .filter((a): a is { type: 'SEND'; text: string } => a.type === 'SEND')
    .map((a) => a.text);

describe('primer contacto y menú (deterministas)', () => {
  it('el saludo inicial recibe el menú fijo sin llamar al modelo', async () => {
    const { e, llm } = engine([]);
    const r = await e.runTurn(state({ history: [] }), ['Hola']);
    expect(sent(r)).toEqual([T.MENU]);
    expect(r.validationResult).toBe('NO_LLM');
    expect(llm.requests).toHaveLength(0);
  });

  it('opción A va a PERFIL con proceso PORTABILIDAD sin modelo', async () => {
    const { e, llm } = engine([]);
    const r = await e.runTurn(state(), ['A']);
    expect(r.stage).toBe('PERFIL');
    expect(r.profile.process).toBe('PORTABILIDAD');
    expect(llm.requests).toHaveLength(0);
  });

  it('opción D redirige a soporte con plantilla y cierra', async () => {
    const { e } = engine([]);
    const r = await e.runTurn(state(), ['opción d']);
    expect(r.stage).toBe('SOPORTE');
    expect(sent(r)).toEqual([T.SUPPORT]);
    expect(r.actions).toContainEqual({ type: 'CLOSE', reason: 'SUPPORT' });
  });

  it('elección en texto libre la interpreta el modelo', async () => {
    const { e } = engine([
      out({ intent: 'ELIGE_OPCION', option: 'C', reply: '¡Genial! ¿Cómo te llamas?' }),
    ]);
    const r = await e.runTurn(state(), ['quiero una línea nueva por favor']);
    expect(r.stage).toBe('PERFIL');
    expect(r.profile.process).toBe('LINEA_NUEVA');
  });
});

describe('perfil → oferta', () => {
  const perfil = state({
    stage: 'PERFIL',
    profile: { process: 'PORTABILIDAD', name: 'Ana', currentOperator: 'Otro' },
  });

  it('con el perfil completo muestra la ficha oficial del plan elegido por el modelo', async () => {
    const { e } = engine([
      out({
        intent: 'DA_DATO',
        reply: 'Te recomiendo este plan:\n{{OFERTA:P2}}\n¿Te gustaría?',
        extracted: { name: null, currentOperator: null, usage: 'videos y redes' },
      }),
    ]);
    const r = await e.runTurn(perfil, ['uso mucho videos y redes']);
    expect(r.stage).toBe('OFERTA');
    const text = sent(r)[0]!;
    expect(text).toContain('Plan Porta Plus (DEMO)');
    expect(text).toContain('$59.900');
    expect(text).not.toContain('{{');
    expect(r.profile.offeredPlanCode).toBe('P2');
  });

  it('si el modelo no ofrece plan, el código agrega la lista oficial', async () => {
    const { e } = engine([
      out({
        intent: 'DA_DATO',
        reply: '¡Gracias, Ana!',
        extracted: { name: null, currentOperator: null, usage: 'llamadas' },
      }),
    ]);
    const r = await e.runTurn(perfil, ['más que todo llamadas']);
    expect(r.stage).toBe('OFERTA');
    expect(sent(r)[0]).toContain('Plan Porta Básico (DEMO)');
  });

  it('ofrecer un plan con el perfil incompleto obliga a regenerar', async () => {
    const { e, llm } = engine([
      out({ intent: 'DA_DATO', reply: 'Mira: {{OFERTA:P1}}' }),
      out({ intent: 'DA_DATO', reply: '¿Cómo usas más tu celular?' }),
    ]);
    const r = await e.runTurn(perfil, ['ok']);
    expect(llm.requests).toHaveLength(2);
    expect(r.validationResult).toBe('REGENERATED');
    expect(r.stage).toBe('PERFIL');
  });
});

describe('anti-alucinación', () => {
  const oferta = state({
    stage: 'OFERTA',
    profile: {
      process: 'PORTABILIDAD',
      name: 'Ana',
      currentOperator: 'X',
      usage: 'redes',
      offeredPlanCode: 'P1',
    },
  });

  it('precio inventado → regenera → si persiste, respuesta segura de plantilla', async () => {
    const { e } = engine([
      out({ reply: 'Te lo dejo en $30.000' }),
      out({ reply: 'Bueno, te lo dejo en treinta mil pesos' }),
    ]);
    const r = await e.runTurn(oferta, ['¿y si me lo dejas en $30.000?']);
    expect(r.validationResult).toBe('FALLBACK');
    expect(sent(r)).toEqual([T.SAFE_FALLBACK]);
    expect(r.stage).toBe('OFERTA');
    expect(r.llmCalls.map((c) => c.validationResult)).toEqual(['FALLBACK', 'FALLBACK']);
  });

  it('plan inexistente → regenera y usa la versión corregida', async () => {
    const { e } = engine([
      out({ reply: 'Tenemos el ilimitado: {{OFERTA:U1}}' }),
      out({ reply: 'No manejamos ese plan, pero este te puede servir:\n{{OFERTA:P2}}' }),
    ]);
    const r = await e.runTurn(oferta, ['¿tienen plan ilimitado?']);
    expect(r.validationResult).toBe('REGENERATED');
    expect(sent(r)[0]).toContain('Plan Porta Plus (DEMO)');
  });

  it('plan de otro proceso no se puede aceptar', async () => {
    const { e } = engine([
      out({ intent: 'ACEPTA_PLAN', planCode: 'M2', reply: '¡Excelente elección!' }),
      out({ intent: 'ACEPTA_PLAN', planCode: 'M2', reply: '¡Excelente elección!' }),
    ]);
    const r = await e.runTurn(oferta, ['quiero el M2']);
    expect(r.stage).toBe('OFERTA');
    expect(r.validationResult).toBe('FALLBACK');
  });

  it('salida que no cumple el esquema → respuesta segura', async () => {
    const { e } = engine(['texto libre', { intent: 'X' }]);
    const r = await e.runTurn(oferta, ['hola']);
    expect(sent(r)).toEqual([T.SAFE_FALLBACK]);
  });
});

describe('aceptación, autorización y transferencia', () => {
  const oferta = state({
    stage: 'OFERTA',
    profile: {
      process: 'PORTABILIDAD',
      name: 'Ana',
      currentOperator: 'X',
      usage: 'redes',
      offeredPlanCode: 'P1',
    },
  });

  it('ACEPTA_PLAN válido pasa a AUTORIZACION con el texto legal fijo y fecha de Bogotá', async () => {
    const { e } = engine([
      out({ intent: 'ACEPTA_PLAN', planCode: 'P1', reply: '¡Excelente elección, Ana! 🎉' }),
    ]);
    const r = await e.runTurn(oferta, ['sí, quiero ese']);
    expect(r.stage).toBe('AUTORIZACION');
    expect(r.profile.planCode).toBe('P1');
    const text = sent(r)[0]!;
    expect(text).toContain('Ley 1266 de 2008');
    expect(text).toContain(T.bogotaDateTime(NOW));
  });

  const auth = state({
    stage: 'AUTORIZACION',
    profile: {
      process: 'PORTABILIDAD',
      name: 'Ana',
      planCode: 'P1',
      authorizationShownAt: NOW.toISOString(),
    },
    history: [{ role: 'bot', text: T.authorization(NOW) }],
  });

  it('"SÍ AUTORIZO" explícito → TRANSFERENCIA, consentimiento y transferencia, sin modelo', async () => {
    const { e, llm } = engine([]);
    const r = await e.runTurn(auth, ['Sí autorizo']);
    expect(r.stage).toBe('TRANSFERENCIA');
    expect(llm.requests).toHaveLength(0);
    expect(r.actions.map((a) => a.type)).toEqual(['RECORD_CONSENT', 'SEND', 'TRANSFER_BACKOFFICE']);
    expect(r.actions[0]).toMatchObject({
      textShown: T.authorization(NOW),
      customerReply: 'Sí autorizo',
    });
  });

  it('"no" explícito → cierre sin venta con plantilla', async () => {
    const { e } = engine([]);
    const r = await e.runTurn(auth, ['No']);
    expect(r.stage).toBe('CIERRE_SIN_VENTA');
    expect(sent(r)).toEqual([T.NO_SALE_GOODBYE]);
  });

  it('regresión: una pregunta en AUTORIZACION conserva el plan y no repite el texto legal', async () => {
    const { e } = engine([
      out({ intent: 'PREGUNTA', reply: 'Es necesaria para estudiar tu solicitud.' }),
    ]);
    const r = await e.runTurn(auth, ['¿para qué es eso?']);
    expect(r.stage).toBe('AUTORIZACION');
    expect(r.profile.planCode).toBe('P1');
    expect(r.profile.authorizationShownAt).toBe(NOW.toISOString());
    expect(sent(r)[0]).not.toContain('Ley 1266');
  });

  it('respuesta ambigua: aunque el modelo diga AUTORIZA, el código pide confirmación', async () => {
    const { e } = engine([out({ intent: 'AUTORIZA', reply: 'Perfecto' })]);
    const r = await e.runTurn(auth, ['ok dale']);
    expect(r.stage).toBe('AUTORIZACION');
    expect(r.actions.map((a) => a.type)).toEqual(['SEND']);
    expect(sent(r)[0]).toContain('SÍ AUTORIZO');
  });
});

describe('otros caminos', () => {
  it('fuera de alcance escala con plantilla fija', async () => {
    const { e } = engine([out({ intent: 'FUERA_DE_ALCANCE', reply: 'lo que sea' })]);
    const r = await e.runTurn(
      state({ stage: 'OFERTA', profile: { process: 'LINEA_NUEVA', name: 'A', usage: 'x' } }),
      ['quiero poner una queja por mi factura'],
    );
    expect(r.stage).toBe('ESCALAR');
    expect(sent(r)).toEqual([T.ESCALATE]);
    expect(r.actions).toContainEqual({ type: 'ESCALATE' });
  });

  it('proveedor caído → NEEDS_REVIEW, sin mensajes al cliente', async () => {
    const { e } = engine([new LlmProviderError('timeout', 'scripted', true)]);
    const r = await e.runTurn(state({ stage: 'OFERTA', profile: { process: 'LINEA_NUEVA' } }), [
      'hola?',
    ]);
    expect(r.validationResult).toBe('PROVIDER_ERROR');
    expect(sent(r)).toEqual([]);
    expect(r.actions[0]).toMatchObject({ type: 'NEEDS_REVIEW' });
  });

  it('estado terminal: no responde', async () => {
    const { e, llm } = engine([]);
    const r = await e.runTurn(state({ stage: 'TRANSFERENCIA' }), ['hola?']);
    expect(r.actions).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it('la ráfaga de mensajes se procesa como un solo turno', async () => {
    const { e, llm } = engine([
      out({
        intent: 'DA_DATO',
        reply: '¡Gracias! ¿Cuál es tu operador actual?',
        extracted: { name: 'Ana', currentOperator: null, usage: null },
      }),
    ]);
    const r = await e.runTurn(state({ stage: 'PERFIL', profile: { process: 'PORTABILIDAD' } }), [
      'hola',
      'soy Ana',
      'quiero cambiarme',
    ]);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.messages.at(-1)!.content).toBe('hola\nsoy Ana\nquiero cambiarme');
    expect(sent(r)).toHaveLength(1);
    expect(r.profile.name).toBe('Ana');
  });

  it('la parte fija del prompt es idéntica entre turnos (caché)', async () => {
    const { e, llm } = engine([out(), out()]);
    const st = state({ stage: 'OFERTA', profile: { process: 'MIGRACION', name: 'A', usage: 'x' } });
    await e.runTurn(st, ['a']);
    await e.runTurn({ ...st, stage: 'OBJECIONES' }, ['b']);
    expect(llm.requests[0]!.systemFixed).toBe(llm.requests[1]!.systemFixed);
    expect(llm.requests[0]!.systemDynamic).not.toBe(llm.requests[1]!.systemDynamic);
  });
});
