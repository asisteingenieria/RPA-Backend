import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_CONFIG, reviewAgentConfig } from './agent-config.js';
import { agentExport, readAgentExport } from './agent-export.js';

const { id: _id, version: _v, ...base } = DEFAULT_AGENT_CONFIG;

describe('D-019: exportar e importar el agente', () => {
  it('ida y vuelta: el sobre se reconoce y trae el agente completo', () => {
    const file = JSON.parse(
      JSON.stringify(agentExport(base, { version: 19, estado: 'PUBLISHED' })),
    );
    const r = readAgentExport(file);
    expect(r.ok && r.origen).toEqual({ version: 19, estado: 'PUBLISHED' });
    expect(r.ok && r.agente).toMatchObject({ prompt: base.prompt, flow: base.flow });
  });

  it('rechaza lo que no es una exportación del agente', () => {
    expect(readAgentExport('x').ok).toBe(false);
    expect(readAgentExport({ formato: 'abaya-brain', version: 1 }).ok).toBe(false);
    expect(readAgentExport({ formato: 'abaya-agente', version: 2, agente: {} }).ok).toBe(false);
    expect(readAgentExport({ formato: 'abaya-agente', version: 1 }).ok).toBe(false);
  });

  it('el guion no puede nombrar una plantilla que no existe o que no es de respuesta', () => {
    const issues = (prompt: string) => reviewAgentConfig({ ...base, prompt }).map((i) => i.message);
    expect(issues('# Rol\n- {{PLANTILLA:perfil-uso}}')).toEqual([]);
    expect(issues('# Rol\n- {{PLANTILLA:perfil-usos}}')).toEqual([
      'la plantilla «perfil-usos» no existe entre las plantillas de respuesta del agente',
    ]);
    // La autorización la envía el sistema: no se pide desde el guion.
    expect(issues('# Rol\n- {{PLANTILLA:autorizacion}}')).toHaveLength(1);
  });
});
