-- Vista «Consumo» del panel: tokens de los usos que no son conversaciones (esas quedan en LlmCall).
CREATE TYPE "UsageKind" AS ENUM ('VOICE', 'IMAGE_READ', 'EMBEDDING', 'EVAL', 'TEST');

CREATE TABLE "ModelUsage" (
    "id" TEXT NOT NULL,
    "kind" "UsageKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModelUsage_createdAt_idx" ON "ModelUsage"("createdAt");
CREATE INDEX "LlmCall_createdAt_idx" ON "LlmCall"("createdAt");
