-- D-011: imágenes de planes en los Brains (validadas contra el catálogo de la versión).
ALTER TYPE "KnowledgeUse" ADD VALUE 'IMAGE';

CREATE TABLE "VersionImage" (
    "id" TEXT NOT NULL,
    "brainVersionId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "blobRef" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "processes" TEXT[],
    "ord" INTEGER NOT NULL,
    "cards" JSONB NOT NULL,

    CONSTRAINT "VersionImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VersionImage_brainVersionId_idx" ON "VersionImage"("brainVersionId");
CREATE INDEX "VersionImage_blobRef_idx" ON "VersionImage"("blobRef");

ALTER TABLE "VersionImage" ADD CONSTRAINT "VersionImage_brainVersionId_fkey" FOREIGN KEY ("brainVersionId") REFERENCES "BrainVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
