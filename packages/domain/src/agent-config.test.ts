import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_CONFIG,
  SYSTEM_RULES,
  buildSystemPrompt,
  menuText,
  reviewAgentConfig,
  stageHint,
} from './agent-config.js';

const { id: _id, version: _v, ...base } = DEFAULT_AGENT_CONFIG;

describe('revisión del guion (regla 11)', () => {
  it('la versión por defecto pasa la revisión', () => {
    expect(reviewAgentConfig(base)).toEqual([]);
  });

  it.each([
    ['Precio: $ 99.900 (IVA incluido)', 'precio'],
    ['vale 60.900', 'precio'],
    ['te lo dejo en 30 mil', 'precio'],
    ['Datos: 55 GB', 'gigas'],
    ['100 megas para compartir', 'gigas'],
    ['Descuento del 20 %', 'porcentaje'],
  ])('rechaza «%s» (%s) con el número de línea', (line, kind) => {
    const issues = reviewAgentConfig({ ...base, prompt: `# Planes\n\n- ${line}` });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'prompt', line: 3 });
    expect(issues[0]!.message.startsWith(kind)).toBe(true);
  });

  it('acepta marcadores, leyes, líneas de atención y redes 5G', () => {
    const prompt =
      '## OFERTA\n- Muestra {{OFERTA:L1}} o {{OFERTA:M2}}.\n' +
      '- Soporte: marcar *611. Ley 1581 de 2012 y Ley 1266 de 2008.\n- Cobertura 5G.';
    expect(reviewAgentConfig({ ...base, prompt })).toEqual([]);
  });

  it('la bienvenida no admite promesas prohibidas, marcadores, enlaces ni cifras', () => {
    const fields = (welcome: string) => reviewAgentConfig({ ...base, welcome }).map((i) => i.field);
    expect(fields('¡Hola! Te regalo un plan')).toEqual(['welcome']);
    expect(fields('Hola {{OFERTA:L1}}')).toEqual(['welcome']);
    expect(fields('Visita https://ejemplo.com')).toEqual(['welcome']);
    expect(fields('Planes desde $40.000')).toEqual(['welcome']);
    expect(fields('¡Hola! 👋 Soy Sofía, tu asesora.')).toEqual([]);
  });

  it('campos obligatorios, longitud y temperatura', () => {
    const issues = reviewAgentConfig({
      ...base,
      agentName: '  ',
      prompt: 'x'.repeat(30_001),
      temperature: 0.7,
    });
    expect(issues.map((i) => i.field).sort()).toEqual(['agentName', 'prompt', 'temperature']);
  });
});

describe('armado del prompt', () => {
  it('las reglas del sistema van primero y el guion después', () => {
    const p = buildSystemPrompt({ ...DEFAULT_AGENT_CONFIG, agentName: 'Sofía', prompt: 'GUION' });
    expect(p.startsWith(SYSTEM_RULES)).toBe(true);
    expect(p.indexOf('GUION')).toBeGreaterThan(SYSTEM_RULES.length);
    expect(p).toContain('Te llamas Sofía');
    expect(p.trimEnd().endsWith('mandan las reglas del sistema.')).toBe(true);
  });

  it('la etapa actual apunta a su sección del guion', () => {
    expect(stageHint('PERFIL')).toBe(
      'Etapa actual: PERFIL. Sigue la sección "## PERFIL" del guion.',
    );
  });

  it('el menú es la bienvenida más las opciones fijas A–D', () => {
    const m = menuText('  Hola, soy Sofía  ');
    // D-003: menú de la campaña (🅐–🅓) justo después de la bienvenida.
    expect(m.startsWith('Hola, soy Sofía\n🅐 Cambiarme de operador')).toBe(true);
    expect(m.endsWith('🅓 Cancelar mi plan pospago')).toBe(true);
  });
});
