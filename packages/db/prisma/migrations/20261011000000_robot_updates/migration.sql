-- AlterTable
ALTER TABLE "Robot" ADD COLUMN     "updateAt" TIMESTAMP(3),
ADD COLUMN     "updateMessage" TEXT,
ADD COLUMN     "updateRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updateStatus" TEXT,
ADD COLUMN     "updateVersion" TEXT;

