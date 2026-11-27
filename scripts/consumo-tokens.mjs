// Consumo de tokens por mensaje, conversación, etapa, audio, imagen, evaluación y prueba.
// Solo cifras agregadas: ningún contenido, id de caso ni dato personal.
// Uso (desde la raíz del backend): node --env-file=.env scripts/consumo-tokens.mjs [desde AAAA-MM-DD]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const req = createRequire(join(process.cwd(), 'packages/db/package.json'));
const { Client, types } = req('pg');
types.setTypeParser(20, Number); // bigint
types.setTypeParser(1700, Number); // numeric
const desde = process.argv[2] ?? '2026-10-23';
const c = new Client({ connectionString: process.env.DATABASE_URL.split('?')[0] });
await c.connect();

const BOG = `- interval '5 hours'`;
const q = {
  // Día de Bogotá × uso × modelo (CHAT = conversaciones reales, en LlmCall).
  porDia: `
    SELECT to_char("createdAt" ${BOG}, 'YYYY-MM-DD') dia, 'CHAT' uso, model modelo, count(*)::int llamadas,
           sum("inputTokens")::bigint entrada, sum("outputTokens")::bigint salida
    FROM "LlmCall" WHERE "createdAt" >= $1::date + interval '5 hours' GROUP BY 1,2,3
    UNION ALL
    SELECT to_char("createdAt" ${BOG}, 'YYYY-MM-DD'), kind::text, model, count(*)::int,
           sum("inputTokens")::bigint, sum("outputTokens")::bigint
    FROM "ModelUsage" WHERE "createdAt" >= $1::date + interval '5 hours' GROUP BY 1,2,3
    ORDER BY 1,2`,
  // Tamaño de cada llamada por uso.
  porLlamada: `
    WITH u AS (
      SELECT 'CHAT' uso, "inputTokens" i, "outputTokens" o, "latencyMs" ms FROM "LlmCall"
       WHERE "createdAt" >= $1::date + interval '5 hours'
      UNION ALL
      SELECT kind::text, "inputTokens", "outputTokens", "latencyMs" FROM "ModelUsage"
       WHERE "createdAt" >= $1::date + interval '5 hours')
    SELECT uso, count(*)::int llamadas, round(avg(i))::int entrada_prom,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY i) entrada_p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY i) entrada_p95, max(i) entrada_max,
           round(avg(o))::int salida_prom, percentile_disc(0.95) WITHIN GROUP (ORDER BY o) salida_p95,
           round(avg(ms))::int latencia_ms
    FROM u GROUP BY 1 ORDER BY 1`,
  // Conversaciones reales: llamadas, mensajes y tokens de cada una (agregado).
  porConversacion: `
    WITH lc AS (
      SELECT "conversationId" id, count(*) llamadas,
             count(*) FILTER (WHERE "validationResult" <> 'OK') no_ok,
             sum("inputTokens") entrada, sum("outputTokens") salida
      FROM "LlmCall" GROUP BY 1),
    m AS (
      SELECT "conversationId" id,
             count(*) FILTER (WHERE direction = 'INBOUND') entrantes,
             count(*) FILTER (WHERE direction = 'OUTBOUND') salientes,
             count(*) FILTER (WHERE "mediaKind"::text = 'AUDIO') audios,
             count(*) FILTER (WHERE "mediaKind"::text = 'IMAGE') imagenes
      FROM "Message" GROUP BY 1),
    x AS (
      SELECT cv.status::text estado, (s.id IS NOT NULL) venta, coalesce(lc.llamadas,0) llamadas,
             coalesce(lc.no_ok,0) no_ok, coalesce(lc.entrada,0) entrada, coalesce(lc.salida,0) salida,
             coalesce(m.entrantes,0) entrantes, coalesce(m.salientes,0) salientes,
             coalesce(m.audios,0) audios, coalesce(m.imagenes,0) imagenes
      FROM "Conversation" cv
      LEFT JOIN lc ON lc.id = cv.id LEFT JOIN m ON m.id = cv.id LEFT JOIN "Sale" s ON s."conversationId" = cv.id
      WHERE cv."createdAt" >= $1::date + interval '5 hours')
    SELECT CASE WHEN venta THEN 'CON_VENTA' ELSE estado END resultado, count(*)::int conversaciones,
           sum(llamadas)::int llamadas, sum(no_ok)::int regeneradas_o_fallback,
           sum(entrantes)::int mensajes_cliente, sum(salientes)::int mensajes_robot,
           sum(audios)::int audios, sum(imagenes)::int imagenes,
           sum(entrada)::bigint entrada, sum(salida)::bigint salida,
           round(avg(entrada + salida))::int tokens_prom_conv,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY entrada + salida) tokens_p50_conv,
           percentile_disc(0.9) WITHIN GROUP (ORDER BY entrada + salida) tokens_p90_conv,
           max(entrada + salida) tokens_max_conv,
           round(avg(llamadas), 1) llamadas_prom_conv, round(avg(entrantes), 1) mensajes_cliente_prom
    FROM x GROUP BY 1 ORDER BY 2 DESC`,
  // Por etapa de la máquina de estados.
  porEtapa: `
    SELECT stage etapa, count(*)::int llamadas, round(avg("inputTokens"))::int entrada_prom,
           round(avg("outputTokens"))::int salida_prom,
           count(*) FILTER (WHERE "validationResult" = 'REGENERATED')::int regeneradas,
           count(*) FILTER (WHERE "validationResult" = 'FALLBACK')::int fallback
    FROM "LlmCall" WHERE "createdAt" >= $1::date + interval '5 hours' GROUP BY 1 ORDER BY 2 DESC`,
  // Por versión del agente (el guion pesa en cada llamada).
  porVersionAgente: `
    SELECT coalesce(v.version::text, 'sin versión') version, count(*)::int llamadas,
           round(avg(l."inputTokens"))::int entrada_prom, round(avg(l."outputTokens"))::int salida_prom
    FROM "LlmCall" l JOIN "Conversation" cv ON cv.id = l."conversationId"
    LEFT JOIN "AgentConfigVersion" v ON v.id = cv."agentVersionId"
    WHERE l."createdAt" >= $1::date + interval '5 hours' GROUP BY 1 ORDER BY 1`,
  // Adjuntos del cliente (D-047): cuántos, duración y resultado.
  adjuntos: `
    SELECT "mediaKind"::text tipo, coalesce("transcriptStatus"::text, 'SIN_ESTADO') resultado,
           count(*)::int mensajes, round(avg("mediaDurationSec"), 1) duracion_prom_s,
           round(avg("transcriptMs"))::int procesamiento_ms
    FROM "Message" WHERE "mediaKind" IS NOT NULL AND "createdAt" >= $1::date + interval '5 hours'
    GROUP BY 1,2 ORDER BY 1,2`,
};

const out = { generado: new Date().toISOString(), desde };
for (const [k, sql] of Object.entries(q)) {
  try {
    out[k] = (await c.query(sql, [desde])).rows;
  } catch (e) {
    out[k] = { error: String(e.message) };
  }
}
await c.end();

const json = JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
const file = `consumo-tokens-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, json);
console.log(json);
console.error(`\nGuardado en ${join(process.cwd(), file)}`);
