-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "respondsToAt" TIMESTAMP(3),
ADD COLUMN     "sentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Message_sentAt_idx" ON "Message"("sentAt");

