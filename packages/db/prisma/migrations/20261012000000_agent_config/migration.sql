-- CreateEnum
CREATE TYPE "AgentConfigStatus" AS ENUM ('DRAFT', 'EVALUATING', 'PUBLISHED', 'ARCHIVED', 'REJECTED');

-- CreateTable
CREATE TABLE "AgentConfigVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AgentConfigStatus" NOT NULL DEFAULT 'DRAFT',
    "agentName" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "companyInfo" TEXT NOT NULL,
    "welcome" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "model" TEXT,
    "temperature" DOUBLE PRECISION NOT NULL,
    "evalSummary" JSONB,
    "createdBy" TEXT NOT NULL,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentConfigVersion_version_key" ON "AgentConfigVersion"("version");

-- CreateIndex
CREATE INDEX "AgentConfigVersion_status_idx" ON "AgentConfigVersion"("status");
