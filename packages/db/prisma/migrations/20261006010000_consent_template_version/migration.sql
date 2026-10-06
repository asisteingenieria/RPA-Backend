-- Versión de la plantilla legal en la evidencia de consentimiento (F8).
-- Las filas previas (solo desarrollo) quedan marcadas como desconocidas.
ALTER TABLE "ConsentEvidence" ADD COLUMN "templateVersion" TEXT NOT NULL DEFAULT 'desconocida';
ALTER TABLE "ConsentEvidence" ALTER COLUMN "templateVersion" DROP DEFAULT;
