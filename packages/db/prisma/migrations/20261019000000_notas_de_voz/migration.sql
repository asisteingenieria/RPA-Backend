-- D-010: notas de voz del cliente. El robot sube el audio, el worker lo transcribe y el motor
-- recibe el texto. El audio cifrado se borra al transcribir; queda la transcripción cifrada.
CREATE TYPE "MediaKind" AS ENUM ('AUDIO');
CREATE TYPE "TranscriptStatus" AS ENUM ('PENDING', 'OK', 'UNINTELLIGIBLE', 'TOO_LONG', 'FAILED');

ALTER TABLE "Message"
  ADD COLUMN "mediaKind" "MediaKind",
  ADD COLUMN "mediaMimeType" TEXT,
  ADD COLUMN "mediaDurationSec" INTEGER,
  ADD COLUMN "mediaEncrypted" BYTEA,
  ADD COLUMN "transcriptStatus" "TranscriptStatus",
  ADD COLUMN "transcriptModel" TEXT,
  ADD COLUMN "transcriptMs" INTEGER;
