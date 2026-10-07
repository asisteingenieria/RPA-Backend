/**
 * Prompts (sección 6.3.6 y 6.3.8). Desde v1.8 el guion se edita en el panel y vive en
 * `AgentConfigVersion`; las reglas del sistema (no editables), la versión por defecto y el
 * armado del prompt están en `@abaya/domain` para que la API muestre y revise lo mismo que usa
 * el motor. Ningún cambio sale a producción sin pasar la suite de evaluación (regla 13).
 */
export {
  DEFAULT_AGENT_CONFIG,
  SYSTEM_RULES,
  buildSystemPrompt,
  stageHint,
  type AgentConfig,
} from '@abaya/domain';
