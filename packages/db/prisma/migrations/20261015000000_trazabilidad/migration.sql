-- D-002 Trazabilidad: permiso «Ver conversaciones», marca de contenido borrado por retención e
-- índices para listar conversaciones por robot, tipificación y fecha.

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "conversationViewer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "contentPurgedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Conversation_robotUser_createdAt_idx" ON "Conversation"("robotUser", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_status_createdAt_idx" ON "Conversation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_createdAt_idx" ON "Conversation"("createdAt");
