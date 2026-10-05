-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'WAITING_CONSENT', 'TRANSFERRING', 'TRANSFERRED_BACKOFFICE', 'CLOSED_NO_SALE', 'CLOSED_SUPPORT', 'CLOSED_INACTIVE', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('PENDING', 'SENDING', 'SENT_VERIFIED', 'UNCERTAIN', 'FAILED');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "abayaChatId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'MENU',
    "profileEncrypted" BYTEA,
    "robotUser" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "customerRefHash" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "fingerprint" TEXT,
    "idempotencyKey" TEXT,
    "bodyEncrypted" BYTEA NOT NULL,
    "status" "OutboundStatus",
    "detectedVia" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "process" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "summaryEncrypted" BYTEA NOT NULL,
    "transferredAt" TIMESTAMP(3),
    "backofficeNoteOk" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentEvidence" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "conversationId" TEXT NOT NULL,
    "textShownHash" TEXT NOT NULL,
    "customerReplyEncrypted" BYTEA NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "ConsentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RpaSession" (
    "id" TEXT NOT NULL,
    "robotUser" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RpaSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RpaActionLog" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "robotUser" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "abayaChatId" TEXT,
    "result" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "traceRef" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RpaActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "code" TEXT NOT NULL,
    "process" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dataGb" INTEGER NOT NULL,
    "priceCop" INTEGER NOT NULL,
    "discountText" TEXT,
    "benefits" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "approvedBy" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "validationResult" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_abayaChatId_key" ON "Conversation"("abayaChatId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_fingerprint_key" ON "Message"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Message_idempotencyKey_key" ON "Message"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Message_conversationId_occurredAt_idx" ON "Message"("conversationId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_conversationId_key" ON "Sale"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentEvidence_seq_key" ON "ConsentEvidence"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentEvidence_prevHash_key" ON "ConsentEvidence"("prevHash");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentEvidence_hash_key" ON "ConsentEvidence"("hash");

-- CreateIndex
CREATE INDEX "ConsentEvidence_conversationId_idx" ON "ConsentEvidence"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "RpaSession_robotUser_key" ON "RpaSession"("robotUser");

-- CreateIndex
CREATE UNIQUE INDEX "RpaActionLog_seq_key" ON "RpaActionLog"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "RpaActionLog_hash_key" ON "RpaActionLog"("hash");

-- CreateIndex
CREATE INDEX "RpaActionLog_robotUser_createdAt_idx" ON "RpaActionLog"("robotUser", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RpaActionLog_robotUser_prevHash_key" ON "RpaActionLog"("robotUser", "prevHash");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_stage_version_key" ON "PromptVersion"("stage", "version");

-- CreateIndex
CREATE INDEX "LlmCall_conversationId_idx" ON "LlmCall"("conversationId");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_idx" ON "OutboxEvent"("publishedAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

