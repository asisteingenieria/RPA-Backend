import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_CONFIG,
  buildSystemPrompt,
  menuText,
  reviewAgentConfig,
} from './agent-config.js';
import {
  DEFAULT_FLOW,
  isOtherOperator,
  isOwnOperator,
  isWorkUsage,
  menuForModel,
  needsLineType,
  menuOptionsText,
  processForOption,
  reviewFlow,
  routeByOperator,
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
      sharedImages: 'SI_USO_LABORAL',
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
    // D-024: compartidas en Portabilidad y Migración solo con uso laboral.
    expect(DEFAULT_FLOW.processes.PORTABILIDAD.sharedImages).toBe('SI_USO_LABORAL');
    expect(DEFAULT_FLOW.processes.MIGRACION.sharedImages).toBe('SI_USO_LABORAL');
    expect(DEFAULT_FLOW.processes.LINEA_NUEVA.sharedImages).toBe('CON_LAS_DEMAS');
    const f = storedFlow({
      processes: { LINEA_NUEVA: { imageOrder: 'CARGA' }, MIGRACION: { imageOrder: 'X' } },
    });
    expect(f.processes.LINEA_NUEVA.imageOrder).toBe('CARGA');
    expect(f.processes.MIGRACION.imageOrder).toBe('PROPIAS_PRIMERO');
  });

  it('D-024: uso laboral reconocido por las palabras del flujo (no si va negado)', () => {
    expect(isWorkUsage('trabajo', DEFAULT_FLOW)).toBe(true);
    expect(isWorkUsage('Más que todo para cosas LABORALES', DEFAULT_FLOW)).toBe(true);
    expect(isWorkUsage('para mi negocio y redes', DEFAULT_FLOW)).toBe(true);
    expect(isWorkUsage('redes sociales', DEFAULT_FLOW)).toBe(false);
    expect(isWorkUsage('no es para trabajo, es para redes', DEFAULT_FLOW)).toBe(false);
    expect(isWorkUsage(undefined, DEFAULT_FLOW)).toBe(false);
    expect(isWorkUsage('trabajo', { ...DEFAULT_FLOW, workUsageWords: [] })).toBe(false);
    // Versiones anteriores sin la lista: la de la campaña; la lista guardada se respeta.
    expect(storedFlow({}).workUsageWords).toEqual(DEFAULT_FLOW.workUsageWords);
    expect(storedFlow({ workUsageWords: [' chamba ', 3, ''] }).workUsageWords).toEqual(['chamba']);
    expect(reviewFlow({ ...DEFAULT_FLOW, workUsageWords: [] }, [])).toContainEqual({
      message:
        'uso laboral: sin palabras, las imágenes compartidas «solo si el uso es laboral» nunca se ofrecen',
    });
    expect(
      reviewFlow({ ...DEFAULT_FLOW, workUsageWords: ['$99.900'] }, []).map((i) => i.message),
    ).toContainEqual(expect.stringContaining('no es una palabra válida'));
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

describe('D-021: proceso según el operador del cliente', () => {
  const flow = DEFAULT_FLOW;

  it('reconoce el operador propio sin importar mayúsculas, tildes ni palabras de más', () => {
    for (const s of ['Claro', 'claro', 'CLARO', 'de Claro', 'claro colombia', 'Claro!'])
      expect(isOwnOperator(s, flow)).toBe(true);
    for (const s of ['Movistar', 'Tigo', 'aclaro', undefined])
      expect(isOwnOperator(s, flow)).toBe(false);
    expect(isOtherOperator('Tigo', flow)).toBe(true);
    expect(isOtherOperator('Claro', flow)).toBe(false);
    expect(isOtherOperator('no sé', flow)).toBe(false);
    expect(isOtherOperator('recargas', flow)).toBe(false);
  });

  it('A + Claro: falta el tipo de línea; prepago → migración, pospago → YA_POSPAGO', () => {
    const p = { process: 'PORTABILIDAD' as const, currentOperator: 'Claro' };
    expect(needsLineType(p, flow)).toBe(true);
    expect(routeByOperator(p, flow)).toBeNull();
    expect(routeByOperator({ ...p, lineType: 'PREPAGO' }, flow)).toEqual({ to: 'MIGRACION' });
    expect(routeByOperator({ ...p, lineType: 'POSPAGO' }, flow)).toEqual({ postpaid: true });
    expect(needsLineType({ ...p, currentOperator: 'Tigo' }, flow)).toBe(false);
    expect(
      routeByOperator({ ...p, currentOperator: 'Tigo', lineType: 'PREPAGO' }, flow),
    ).toBeNull();
  });

  it('B + otro operador → portabilidad; B + Claro sigue en migración', () => {
    expect(routeByOperator({ process: 'MIGRACION', currentOperator: 'Movistar' }, flow)).toEqual({
      to: 'PORTABILIDAD',
    });
    expect(routeByOperator({ process: 'MIGRACION', currentOperator: 'Claro' }, flow)).toBeNull();
    expect(routeByOperator({ process: 'LINEA_NUEVA', currentOperator: 'Tigo' }, flow)).toBeNull();
  });

  it('se apaga por partes desde el flujo', () => {
    const off: AgentFlow = {
      ...flow,
      operatorRouting: {
        ownNames: ['Claro'],
        ownPrepaidTo: null,
        ownPostpaid: 'SEGUIR',
        otherOperatorTo: null,
      },
    };
    const p = { process: 'PORTABILIDAD' as const, currentOperator: 'Claro' };
    expect(needsLineType(p, off)).toBe(false);
    expect(routeByOperator({ ...p, lineType: 'PREPAGO' }, off)).toBeNull();
    expect(routeByOperator({ process: 'MIGRACION', currentOperator: 'Tigo' }, off)).toBeNull();
  });

  it('versiones guardadas sin la opción toman la de la campaña; null se respeta', () => {
    expect(storedFlow({}).operatorRouting).toEqual(DEFAULT_FLOW.operatorRouting);
    const s = storedFlow({
      operatorRouting: { ownNames: [' Claro ', 7, ''], ownPrepaidTo: null, ownPostpaid: 'X' },
    });
    expect(s.operatorRouting).toEqual({
      ownNames: ['Claro'],
      ownPrepaidTo: null,
      ownPostpaid: 'YA_POSPAGO',
      otherOperatorTo: 'PORTABILIDAD',
    });
  });

  it('la revisión rechaza caminos sin sentido y nombres inválidos', () => {
    const bad: AgentFlow = {
      ...flow,
      operatorRouting: {
        ownNames: ['Claro 20%'],
        ownPrepaidTo: 'PORTABILIDAD',
        ownPostpaid: 'YA_POSPAGO',
        otherOperatorTo: 'MIGRACION',
      },
    };
    const msgs = reviewFlow(bad, ['perfil-operador', 'perfil-uso', 'perfil-uso-directo']).map(
      (i) => i.message,
    );
    expect(msgs.some((m) => m.includes('no es un nombre válido'))).toBe(true);
    expect(msgs.some((m) => m.includes('no puede seguir en portabilidad'))).toBe(true);
    expect(msgs.some((m) => m.includes('no puede seguir en migración'))).toBe(true);
  });

  it('D-022: plataforma pedida → ofrecer directo por defecto; se guarda PERFILAR', () => {
    expect(DEFAULT_FLOW.platformRequest).toBe('OFRECER_DIRECTO');
    expect(storedFlow({}).platformRequest).toBe('OFRECER_DIRECTO');
    expect(storedFlow({ platformRequest: 'PERFILAR' }).platformRequest).toBe('PERFILAR');
    expect(storedFlow({ platformRequest: 'OTRA' }).platformRequest).toBe('OFRECER_DIRECTO');
  });

  it('D-023: consulta de portabilidad → validar por defecto, con sus 4 plantillas del sistema', () => {
    expect(DEFAULT_FLOW.portabilityInquiry).toBe('VALIDAR');
    expect(storedFlow({}).portabilityInquiry).toBe('VALIDAR');
    expect(storedFlow({ portabilityInquiry: 'SOPORTE' }).portabilityInquiry).toBe('SOPORTE');
    expect(storedFlow({ portabilityInquiry: 'X' }).portabilityInquiry).toBe('VALIDAR');
    for (const role of [
      'PORTABILIDAD_CONFIRMACION',
      'PORTABILIDAD_CONFIRMADA',
      'PORTABILIDAD_VALIDAR',
      'PORTABILIDAD_TRANSFERENCIA',
    ] as const)
      expect(systemTemplates(DEFAULT_TEMPLATES, role)).toHaveLength(1);
    expect(systemTemplates(DEFAULT_TEMPLATES, 'PORTABILIDAD_VALIDAR')[0]!.text).toContain(
      '{datos_faltantes}',
    );
  });

  it('la plantilla del sistema YA_POSPAGO existe por defecto y ofrece la opción C', () => {
    const t = DEFAULT_TEMPLATES.find((x) => x.role === 'YA_POSPAGO');
    expect(t?.text).toContain('🅒 Ya tengo plan');
    expect(systemTemplates(DEFAULT_TEMPLATES, 'YA_POSPAGO')).toHaveLength(1);
  });
});
