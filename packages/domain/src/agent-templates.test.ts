import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_CONFIG, buildSystemPrompt } from './agent-config.js';
import {
  DEFAULT_REACTIVATION,
  DEFAULT_TEMPLATES,
  bogotaShortDate,
  parseTemplates,
  renderTemplate,
  reviewTemplates,
  storedReactivation,
  storedTemplates,
  templateByRole,
  type AgentTemplate,
} from './agent-templates.js';

describe('D-013: plantillas de la campaña (hoja «Plantillas», celdas verdes)', () => {
  it('las de la campaña pasan la revisión y tienen los roles que usa el sistema', () => {
    expect(reviewTemplates(DEFAULT_TEMPLATES, DEFAULT_REACTIVATION)).toEqual([]);
    expect(templateByRole(DEFAULT_TEMPLATES, 'AUTORIZACION')!.text).toContain('ley 1266 de 2008');
    expect(templateByRole(DEFAULT_TEMPLATES, 'INTRO_AUTORIZACION')!.text).toContain('cupo');
    expect(templateByRole(DEFAULT_TEMPLATES, 'SOLICITUD_DATOS')!.text).toContain('documento');
    expect(DEFAULT_TEMPLATES.filter((t) => t.role === 'REACTIVACION')).toHaveLength(6);
    // Sin nombres de asesores reales: el nombre lo pone la configuración del agente.
    expect(DEFAULT_TEMPLATES.map((t) => t.text).join('\n')).not.toMatch(/Paula|Camilo/);
  });

  it('variables: fecha de Bogotá dd/mm/aaaa, nombre del agente y del cliente (si se sabe)', () => {
    // 2 de marzo a las 3:00 UTC = 1 de marzo en Bogotá.
    expect(bogotaShortDate(new Date('2026-03-02T03:00:00Z'))).toBe('01/03/2026');
    const v = { agentName: 'Sofía', now: new Date('2026-10-09T15:00:00Z') };
    expect(renderTemplate('Soy {nombre_agente}, hoy {fecha}.', v)).toBe(
      'Soy Sofía, hoy 09/10/2026.',
    );
    expect(renderTemplate('¡Gracias {nombre_cliente}!', { ...v, customerName: 'Ana' })).toBe(
      '¡Gracias Ana!',
    );
    expect(renderTemplate('¡Gracias {nombre_cliente}!', v)).toBe('¡Gracias!');
  });

  it('revisión: roles únicos, ids, variables, formato y reactivación', () => {
    const base = DEFAULT_TEMPLATES;
    const auth = templateByRole(base, 'AUTORIZACION')!;
    const msgs = (t: AgentTemplate[], r = DEFAULT_REACTIVATION) =>
      reviewTemplates(t, r).map((i) => i.message);
    expect(msgs(base.filter((t) => t.role !== 'AUTORIZACION'))).toContain(
      'debe haber exactamente una plantilla de AUTORIZACIÓN',
    );
    expect(msgs([...base, { ...auth, id: 'otra' }])).toContain(
      'debe haber exactamente una plantilla de AUTORIZACIÓN',
    );
    expect(msgs(base.map((t) => (t === auth ? { ...t, text: 'Autoriza? Sí / No' } : t)))).toContain(
      'la autorización debe llevar la fecha del día: escribe {fecha}',
    );
    const extra = (over: Partial<AgentTemplate>): AgentTemplate[] => [
      ...base,
      {
        id: 'nueva',
        group: 'x',
        title: 'Nueva',
        role: 'RESPUESTA',
        when: 'siempre',
        text: 'Hola',
        ...over,
      },
    ];
    expect(msgs(extra({ id: 'saludo-asesoria' }))).toContain('id repetido');
    expect(msgs(extra({ id: 'Con Espacios' }))[0]).toMatch(/^id:/);
    expect(msgs(extra({ when: '' }))[0]).toMatch(/cuándo usarla/);
    expect(msgs(extra({ text: 'Hola {cliente}' }))[0]).toMatch(/variable desconocida/);
    expect(msgs(extra({ text: '**Hola**' }))[0]).toMatch(/formato/);
    expect(msgs(extra({ text: 'Mira {{OFERTA:P1}}' }))).toContain(
      'el texto no admite marcadores {{…}}',
    );
    expect(msgs(base, { minutes: 0, max: 3 })[0]).toMatch(/minutos/);
    expect(msgs(base, { minutes: 5, max: 11 })[0]).toMatch(/entre 0 y 10/);
    expect(
      msgs(
        base.filter((t) => t.role !== 'REACTIVACION'),
        { minutes: 5, max: 2 },
      ),
    ).toContain('reactivación activa sin plantillas de REACTIVACIÓN');
  });

  it('guardado: forma inválida → null; versiones sin plantillas → las de la campaña', () => {
    expect(parseTemplates('x')).toBeNull();
    expect(
      parseTemplates([{ id: 'a', group: 'g', title: 't', role: 'OTRO', text: 'x' }]),
    ).toBeNull();
    expect(
      parseTemplates([{ id: ' a ', group: 'g', title: 't', role: 'RESPUESTA', text: 'x\r\ny ' }]),
    ).toEqual([{ id: 'a', group: 'g', title: 't', role: 'RESPUESTA', when: '', text: 'x\ny' }]);
    expect(storedTemplates(null)).toEqual(DEFAULT_TEMPLATES);
    expect(storedReactivation(null, 0)).toEqual({ minutes: DEFAULT_REACTIVATION.minutes, max: 0 });
  });

  it('el prompt lista solo las plantillas de respuesta, sin su texto', () => {
    const p = buildSystemPrompt(DEFAULT_AGENT_CONFIG);
    expect(p).toContain('# Plantillas de la campaña');
    expect(p).toContain('{{PLANTILLA:perfil-operador}}');
    expect(p).not.toContain('{{PLANTILLA:autorizacion}}');
    expect(p).not.toContain('{{PLANTILLA:reactivacion-sigues-ahi}}');
    // El texto exacto lo pone el código: el modelo no lo ve (no lo reescribe).
    expect(p).not.toContain('¿con que operador manejas tu línea móvil?');
  });
});
