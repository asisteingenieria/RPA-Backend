-- D-004: evaluar al guardar y publicar al instante (con resultado OK / WARN / BLOCKED), nota del
-- cambio, motivo y aplicación urgente al publicar; versión del agente fijada por conversación;
-- pruebas de "Probar agente" guardadas en el historial.

-- AlterTable
ALTER TABLE "AgentConfigVersion" ADD COLUMN     "appliedToOpen" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "changeNote" TEXT,
ADD COLUMN     "evalVerdict" TEXT,
ADD COLUMN     "evaluatedAt" TIMESTAMP(3),
ADD COLUMN     "publishReason" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "agentVersionId" TEXT;

-- CreateTable
CREATE TABLE "AgentTestRecord" (
    "id" TEXT NOT NULL,
    "versionId" TEXT,
    "version" INTEGER,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "transcript" JSONB NOT NULL,
    "finalStage" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTestRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTestRecord_versionId_createdAt_idx" ON "AgentTestRecord"("versionId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_agentVersionId_idx" ON "Conversation"("agentVersionId");
