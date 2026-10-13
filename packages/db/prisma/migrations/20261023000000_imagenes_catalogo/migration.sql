-- D-014: catálogo desde imágenes; circular de apps de video.
ALTER TABLE "VersionImage" ADD COLUMN "videoApps" BOOLEAN NOT NULL DEFAULT false;
