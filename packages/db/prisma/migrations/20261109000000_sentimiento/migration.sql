-- D-035: sentimiento del cliente (solo medición; categoría, no dato personal).
ALTER TABLE "Conversation" ADD COLUMN "sentiment" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "sentimentWorst" TEXT;
