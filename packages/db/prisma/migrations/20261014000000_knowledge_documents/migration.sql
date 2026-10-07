-- v1.9 Brains K3–K5: fragmentos de documentos (contexto completo y búsqueda), fuentes web y
-- permiso publicarConocimiento. Los ADMIN existentes lo reciben para no perder la capacidad de publicar.

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "knowledgePublisher" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "KnowledgeSource" ADD COLUMN     "lastContentHash" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "refreshHours" INTEGER;

-- CreateTable
CREATE TABLE "SourceChunk" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "embeddingModel" TEXT,

    CONSTRAINT "SourceChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VersionChunk" (
    "id" TEXT NOT NULL,
    "brainVersionId" TEXT NOT NULL,
    "use" "KnowledgeUse" NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "metadata" JSONB,

    CONSTRAINT "VersionChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceChunk_sourceId_ord_key" ON "SourceChunk"("sourceId", "ord");

-- CreateIndex
CREATE INDEX "VersionChunk_brainVersionId_use_idx" ON "VersionChunk"("brainVersionId", "use");

-- AddForeignKey
ALTER TABLE "SourceChunk" ADD CONSTRAINT "SourceChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VersionChunk" ADD CONSTRAINT "VersionChunk_brainVersionId_fkey" FOREIGN KEY ("brainVersionId") REFERENCES "BrainVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Datos: los ADMIN actuales conservan la capacidad de publicar catálogos.
UPDATE "AdminUser" SET "knowledgePublisher" = true WHERE "role" = 'ADMIN';
