-- D-014 fase 2: imagen de planes que acompaña a un mensaje saliente (VersionImage.id).
-- El cuerpo del mensaje es el pie de foto. Sin llave foránea: la versión puede purgarse.
ALTER TABLE "Message" ADD COLUMN "imageId" TEXT;
