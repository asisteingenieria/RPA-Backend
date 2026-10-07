-- AlterTable
ALTER TABLE "Robot" ADD COLUMN     "previousTokenHash" TEXT,
ADD COLUMN     "tokenRotatedAt" TIMESTAMP(3),
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Robot_previousTokenHash_key" ON "Robot"("previousTokenHash");

