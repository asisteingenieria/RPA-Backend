-- D-044: segunda lectura del tratamiento de datos (1 = como hasta ahora).
ALTER TABLE "ConsentEvidence" ADD COLUMN "reading" INTEGER NOT NULL DEFAULT 1;

-- D-045: pasos del flujo por conversación (log de auditoría por interacción).
CREATE TABLE "InteractionStep" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "conversationId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "result" TEXT,
    "detail" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InteractionStep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InteractionStep_seq_key" ON "InteractionStep"("seq");
CREATE INDEX "InteractionStep_conversationId_seq_idx" ON "InteractionStep"("conversationId", "seq");
