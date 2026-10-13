-- D-013: plantillas de respuesta del agente y reactivación (versionadas con el agente).
ALTER TABLE "AgentConfigVersion" ADD COLUMN "templates" JSONB;
ALTER TABLE "AgentConfigVersion" ADD COLUMN "reactivationMinutes" INTEGER;
ALTER TABLE "AgentConfigVersion" ADD COLUMN "reactivationMax" INTEGER;
