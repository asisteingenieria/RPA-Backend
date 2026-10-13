-- D-015: flujo de la conversación (menú, datos por proceso, fuera de alcance, orden de imágenes).
ALTER TABLE "AgentConfigVersion" ADD COLUMN "flow" JSONB;
