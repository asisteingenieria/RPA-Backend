import type { AgentConfigInput } from './agent-config.js';

/**
 * D-019: una versión del agente como archivo, para llevarla de un ambiente a otro (local →
 * producción). Lleva todo lo que se edita en el panel; al importarse queda como borrador y pasa
 * por la misma revisión que guardar.
 */
export const AGENT_EXPORT_FORMAT = 'abaya-agente';
export const AGENT_EXPORT_VERSION = 1;

export interface AgentExport {
  formato: typeof AGENT_EXPORT_FORMAT;
  version: typeof AGENT_EXPORT_VERSION;
  exportadoEn: string;
  /** Versión de origen (solo informativo: en el otro ambiente la numeración es otra). */
  origen: { version: number; estado: string };
  agente: AgentConfigInput;
}

export function agentExport(
  agente: AgentConfigInput,
  origen: AgentExport['origen'],
  now: Date = new Date(),
): AgentExport {
  return {
    formato: AGENT_EXPORT_FORMAT,
    version: AGENT_EXPORT_VERSION,
    exportadoEn: now.toISOString(),
    origen,
    agente,
  };
}

/**
 * Lee un archivo exportado. Solo revisa el sobre (formato y versión); el contenido del agente lo
 * revisa quien importa, igual que al guardar desde el panel.
 */
export function readAgentExport(
  raw: unknown,
):
  | { ok: true; agente: Record<string, unknown>; origen: AgentExport['origen'] | null }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: 'el archivo no es un JSON válido' };
  const r = raw as Record<string, unknown>;
  if (r.formato !== AGENT_EXPORT_FORMAT)
    return {
      ok: false,
      error: 'el archivo no es una exportación del agente (formato «abaya-agente»)',
    };
  if (r.version !== AGENT_EXPORT_VERSION)
    return { ok: false, error: `versión de archivo no soportada: ${String(r.version)}` };
  if (!r.agente || typeof r.agente !== 'object')
    return { ok: false, error: 'el archivo no trae la configuración del agente' };
  const o = r.origen as Record<string, unknown> | undefined;
  const origen =
    o && typeof o.version === 'number' && typeof o.estado === 'string'
      ? { version: o.version, estado: o.estado }
      : null;
  return { ok: true, agente: r.agente as Record<string, unknown>, origen };
}
