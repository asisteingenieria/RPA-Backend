import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_CONFIG,
  buildSystemPrompt,
  menuText,
  reviewAgentConfig,
} from './agent-config.js';
import {
  DEFAULT_FLOW,
  menuForModel,
  menuOptionsText,
  processForOption,
  reviewFlow,
  storedFlow,
  type AgentFlow,
} from './agent-flow.js';
import {
  DEFAULT_TEMPLATES,
  renderTemplate,
  storedTemplates,
  systemTemplates,
  withSystemTemplates,
  type AgentTemplate,
} from './agent-templates.js';

const { id: _id, version: _v, ...base } = DEFAULT_AGENT_CONFIG;
const withFlow = (f: Partial<AgentFlow>) => ({ ...base, flow: { ...DEFAULT_FLOW, ...f } });

describe('D-015: flujo de la conversación en el panel', () => {
  it('el flujo por defecto es el de la campaña (el que hacía el código)', () => {
    expect(menuOptionsText(DEFAULT_FLOW)).toBe(
      '🅐 Cambiarme de operador\n🅑 Pasarme de recargas a plan pospago\n' +
        '🅒 Ya tengo plan: soporte, factura o cambio\n🅓 Cancelar mi plan pospago',
    );
    expect(processForOption(DEFAULT_FLOW, 'A')).toBe('PORTABILIDAD');
    expect(processForOption(DEFAULT_FLOW, 'B')).toBe('MIGRACION');
    expect(processForOption(DEFAULT_FLOW, 'C')).toBeUndefined();
    expect(processForOption(DEFAULT_FLOW, 'E')).toBe('LINEA_NUEVA');
    expect(DEFAULT_FLOW.outOfScope.MENU).toBe('SOPORTE');
    expect(DEFAULT_FLOW.outOfScope.OFERTA).toBe('ESCALAR');
  });

  it('el menú y su explicación al modelo salen del flujo', () => {
    const flow: AgentFlow = {
      ...DEFAULT_FLOW,
      menu: DEFAULT_FLOW.menu.map((o) =>
        o.letter === 'C' ? { ...o, text: 'Quiero una línea nueva', action: 'LINEA_NUEVA' } : o,
      ),
    };
    expect(processForOption(flow, 'C')).toBe('LINEA_NUEVA');
    expect(menuText('¡Hola!', flow)).toContain('🅒 Quiero una línea nueva');
    expect(menuForModel(flow)).toContain('C = «Quiero una línea nueva» (línea nueva)');
    expect(buildSystemPrompt({ ...DEFAULT_AGENT_CONFIG, flow })).toContain('# Menú');
  });

  it('versiones sin flujo, o con partes inválidas, usan el de la campaña', () => {
    expect(storedFlow(null)).toEqual(DEFAULT_FLOW);
    const f = storedFlow({
      menu: [{ letter: 'A', text: ' Portarme ', action: 'NADA' }],
      processes: { MIGRACION: { asks: ['usage', 'otro'], firstTemplate: null } },
      outOfScope: { OFERTA: 'SOPORTE', PERFIL: 'CERRAR' },
      imageOrder: 'CARGA',
    });
    expect(f.menu[0]).toEqual({ letter: 'A', text: 'Portarme', action: 'PORTABILIDAD' });
    expect(f.menu).toHaveLength(4);
    // Versiones anteriores: un solo orden de imágenes para todos los procesos (se respeta).
    expect(f.processes.MIGRACION).toEqual({
      asks: ['usage'],
      firstTemplate: null,
      imageOrder: 'CARGA',
      sharedImages: 'SI_PIDE_PLATAFORMA',
    });
    expect(f.processes.PORTABILIDAD).toEqual({
      ...DEFAULT_FLOW.processes.PORTABILIDAD,
      imageOrder: 'CARGA',
    });
    expect(f.outOfScope).toMatchObject({ OFERTA: 'SOPORTE', PERFIL: 'ESCALAR', MENU: 'SOPORTE' });
  });

  it('orden de imágenes por proceso: Portabilidad y Migración las propias primero, Línea nueva por precio', () => {
    expect(DEFAULT_FLOW.processes.PORTABILIDAD.imageOrder).toBe('PROPIAS_PRIMERO');
    expect(DEFAULT_FLOW.processes.MIGRACION.imageOrder).toBe('PROPIAS_PRIMERO');
    expect(DEFAULT_FLOW.processes.LINEA_NUEVA.imageOrder).toBe('PRECIO');
    // Compartidas: en Portabilidad y Migración solo si el cliente nombra lo que incluyen.
    expect(DEFAULT_FLOW.processes.PORTABILIDAD.sharedImages).toBe('SI_PIDE_PLATAFORMA');
    expect(DEFAULT_FLOW.processes.MIGRACION.sharedImages).toBe('SI_PIDE_PLATAFORMA');
    expect(DEFAULT_FLOW.processes.LINEA_NUEVA.sharedImages).toBe('CON_LAS_DEMAS');
    const f = storedFlow({
      processes: { LINEA_NUEVA: { imageOrder: 'CARGA' }, MIGRACION: { imageOrder: 'X' } },
    });
    expect(f.processes.LINEA_NUEVA.imageOrder).toBe('CARGA');
    expect(f.processes.MIGRACION.imageOrder).toBe('PROPIAS_PRIMERO');
  });

  it('revisión: menú sin texto, con cifras o sin venta; primera pregunta inexistente', () => {
    expect(reviewAgentConfig(base)).toEqual([]);
    const msgs = (flow: AgentFlow) => reviewFlow(flow, ['perfil-operador']).map((i) => i.message);
    expect(
      msgs({ ...DEFAULT_FLOW, menu: DEFAULT_FLOW.menu.map((o) => ({ ...o, text: '' })) }),
    ).toContain('menú: la opción A no tiene texto');
    expect(
      msgs({
        ...DEFAULT_FLOW,
        menu: DEFAULT_FLOW.menu.map((o) => ({ ...o, text: 'Plan de 20 GB' })),
      }),
    ).toContain('menú: la opción B no puede llevar precios, gigas ni porcentajes');
    expect(
      msgs({
        ...DEFAULT_FLOW,
        menu: DEFAULT_FLOW.menu.map((o) => ({ ...o, action: 'PREGUNTAR_NECESIDAD' })),
      }),
    ).toContain('menú: al menos una opción debe llevar a un proceso de venta');
    expect(msgs(DEFAULT_FLOW)).toContain(
      'MIGRACION: la primera pregunta «perfil-uso» no es una plantilla de RESPUESTA del agente',
    );
    expect(
      reviewAgentConfig(
        withFlow({
          processes: {
            ...DEFAULT_FLOW.processes,
            LINEA_NUEVA: { ...DEFAULT_FLOW.processes.LINEA_NUEVA, firstTemplate: 'no-existe' },
          },
        }),
      ).map((i) => i.field),
    ).toEqual(['flow']);
  });
});

describe('D-015: plantillas del sistema', () => {
  const sinSistema = DEFAULT_TEMPLATES.filter((t) => t.group !== 'Sistema');

  it('una versión sin plantillas del sistema recibe las de la campaña (mismo texto que el código)', () => {
    const t = storedTemplates(sinSistema);
    expect(t.filter((x) => x.role === 'ESPERA')).toHaveLength(3);
    expect(systemTemplates(sinSistema, 'SOPORTE')[0]!.text).toContain('chat exclusivo de ventas');
    // Las que el agente ya tiene se respetan.
    const propia: AgentTemplate = {
      id: 'mi-soporte',
      group: 'Sistema',
      title: 'x',
      role: 'SOPORTE',
      when: '',
      text: 'Solo vendemos planes.',
    };
    expect(systemTemplates([...sinSistema, propia], 'SOPORTE')).toEqual([propia]);
    expect(
      withSystemTemplates([...sinSistema, propia]).filter((x) => x.role === 'SOPORTE'),
    ).toEqual([propia]);
  });

  it('no admiten cifras (las envía el código sin validarlas contra el catálogo)', () => {
    const templates = DEFAULT_TEMPLATES.map((t) =>
      t.role === 'SOPORTE' ? { ...t, text: 'Tenemos planes desde $45.900' } : t,
    );
    expect(reviewAgentConfig({ ...base, templates }).map((i) => i.message)).toContain(
      'plantilla del sistema: sin precios, gigas ni porcentajes (salen del catálogo)',
    );
  });

  it('solo una por rol, salvo ESPERA', () => {
    const extra = DEFAULT_TEMPLATES.filter((t) => t.role === 'ESCALAR').map((t) => ({
      ...t,
      id: 'otra',
    }));
    expect(
      reviewAgentConfig({ ...base, templates: [...DEFAULT_TEMPLATES, ...extra] }).map(
        (i) => i.message,
      ),
    ).toContain('solo puede haber una plantilla con el rol ESCALAR');
  });

  it('{nombre_cliente} con coma: sin nombre se quita también la coma', () => {
    const tx = '¡Gracias, {nombre_cliente}! Te transfiero.';
    const now = new Date('2026-10-13T15:00:00Z');
    expect(renderTemplate(tx, { agentName: 'Sofía', customerName: 'Ana', now })).toBe(
      '¡Gracias, Ana! Te transfiero.',
    );
    expect(renderTemplate(tx, { agentName: 'Sofía', now })).toBe('¡Gracias! Te transfiero.');
  });
});
