-- D-005: publicar el agente no depende de la evaluación; la evaluación corre aparte como evidencia
-- y se marca con "evalVerdict" = 'RUNNING' en vez del estado EVALUATING de la versión.
-- Las versiones del agente que quedaron en EVALUATING pasan a borrador con la evaluación en curso.
UPDATE "AgentConfigVersion"
SET "status" = 'DRAFT', "evalVerdict" = 'RUNNING'
WHERE "status" = 'EVALUATING';
