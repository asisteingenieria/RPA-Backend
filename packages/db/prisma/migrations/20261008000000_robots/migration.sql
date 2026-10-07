-- CreateTable
CREATE TABLE "Robot" (
    "robotUser" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "abayaPasswordEncrypted" BYTEA,
    "mfaMode" TEXT NOT NULL DEFAULT 'none',
    "totpSecretEncrypted" BYTEA,
    "enrollmentCodeHash" TEXT,
    "enrollmentExpiresAt" TIMESTAMP(3),
    "agentTokenHash" TEXT,
    "enrolledAt" TIMESTAMP(3),
    "host" TEXT,
    "instanceId" TEXT,
    "version" TEXT,
    "state" TEXT NOT NULL DEFAULT 'STOPPED',
    "startedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "lastRejectedHost" TEXT,
    "lastRejectedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Robot_pkey" PRIMARY KEY ("robotUser")
);

-- CreateIndex
CREATE UNIQUE INDEX "Robot_enrollmentCodeHash_key" ON "Robot"("enrollmentCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "Robot_agentTokenHash_key" ON "Robot"("agentTokenHash");

