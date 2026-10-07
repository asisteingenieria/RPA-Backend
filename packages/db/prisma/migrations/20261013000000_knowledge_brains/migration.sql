-- v1.9 Brains (bases de conocimiento), docs/DECISIONS.md D-001.
-- Los planes de "Plan" se pasan al Brain de catálogo desde el worker (bootstrapLegacyCatalog).

-- CreateEnum
CREATE TYPE "BrainVersionStatus" AS ENUM ('DRAFT', 'EVALUATING', 'PUBLISHED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "KnowledgeUse" AS ENUM ('CATALOG', 'FULL_CONTEXT', 'SEARCH');

-- CreateEnum
CREATE TYPE "KnowledgeSourceKind" AS ENUM ('TEXT', 'FILE', 'WEB');

-- CreateEnum
CREATE TYPE "KnowledgeSourceStatus" AS ENUM ('PROCESSING', 'READY', 'ERROR');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "catalogVersionId" TEXT;

-- AlterTable
ALTER TABLE "AdminAuditLog" ADD COLUMN     "detail" JSONB;

-- CreateTable
CREATE TABLE "Brain" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "sourcesChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainVersion" (
    "id" TEXT NOT NULL,
    "brainId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BrainVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "basedOn" INTEGER,
    "diff" JSONB,
    "evalSummary" JSONB,
    "createdBy" TEXT NOT NULL,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "brainId" TEXT NOT NULL,
    "kind" "KnowledgeSourceKind" NOT NULL,
    "use" "KnowledgeUse" NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "blobRef" TEXT,
    "url" TEXT,
    "status" "KnowledgeSourceStatus" NOT NULL DEFAULT 'PROCESSING',
    "errorReason" TEXT,
    "issues" JSONB,
    "parsed" JSONB,
    "lastIngestedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeBlob" (
    "id" TEXT NOT NULL,
    "dataEncrypted" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogRecord" (
    "id" TEXT NOT NULL,
    "brainVersionId" TEXT NOT NULL,
    "process" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "dataText" TEXT NOT NULL,
    "sharedDataText" TEXT,
    "includesText" TEXT,
    "extrasText" TEXT,
    "unlimitedAppsText" TEXT,
    "callsText" TEXT,
    "priceCop" INTEGER NOT NULL,
    "discountText" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "CatalogRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentBrain" (
    "agentKey" TEXT NOT NULL,
    "brainId" TEXT NOT NULL,
    "connectedBy" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentBrain_pkey" PRIMARY KEY ("agentKey","brainId")
);

-- CreateTable
CREATE TABLE "KnowledgeUsage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "brainId" TEXT NOT NULL,
    "brainVersionId" TEXT NOT NULL,
    "brainVersion" INTEGER NOT NULL,
    "kind" "KnowledgeUse" NOT NULL,
    "provided" TEXT[],
    "rendered" TEXT[],
    "recordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brain_name_key" ON "Brain"("name");

-- CreateIndex
CREATE INDEX "BrainVersion_brainId_status_idx" ON "BrainVersion"("brainId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BrainVersion_brainId_version_key" ON "BrainVersion"("brainId", "version");

-- CreateIndex
CREATE INDEX "KnowledgeSource_brainId_idx" ON "KnowledgeSource"("brainId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_brainId_contentHash_key" ON "KnowledgeSource"("brainId", "contentHash");

-- CreateIndex
CREATE INDEX "CatalogRecord_brainVersionId_process_idx" ON "CatalogRecord"("brainVersionId", "process");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogRecord_brainVersionId_code_key" ON "CatalogRecord"("brainVersionId", "code");

-- CreateIndex
CREATE INDEX "KnowledgeUsage_conversationId_idx" ON "KnowledgeUsage"("conversationId");

-- CreateIndex
CREATE INDEX "KnowledgeUsage_brainVersionId_idx" ON "KnowledgeUsage"("brainVersionId");

-- AddForeignKey
ALTER TABLE "BrainVersion" ADD CONSTRAINT "BrainVersion_brainId_fkey" FOREIGN KEY ("brainId") REFERENCES "Brain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_brainId_fkey" FOREIGN KEY ("brainId") REFERENCES "Brain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogRecord" ADD CONSTRAINT "CatalogRecord_brainVersionId_fkey" FOREIGN KEY ("brainVersionId") REFERENCES "BrainVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBrain" ADD CONSTRAINT "AgentBrain_brainId_fkey" FOREIGN KEY ("brainId") REFERENCES "Brain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

