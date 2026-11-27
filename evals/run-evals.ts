/**
 * Suite de evaluación del motor de conversación (sección 12.1).
 *
 *   pnpm evals                                  # línea base heurística (sin red)
 *   pnpm evals --provider anthropic,openai      # proveedores reales (requiere API keys)
 *   pnpm evals --provider gemini                # Gemini (requiere GEMINI_API_KEY)
 *   pnpm evals --provider anthropic --filter feliz-
 *   pnpm evals --provider anthropic --agent borrador.json   # una versión del agente (v1.8)
 *
 * Variables: EVAL_ANTHROPIC_MODEL (por defecto claude-opus-5-5), EVAL_OPENAI_MODEL,
 * EVAL_GEMINI_MODEL (por defecto el del adaptador de Gemini),
 * EVAL_PRICE_<PROVEEDOR>_IN / _OUT (USD por millón de tokens) para el costo.
 * Consumo: con DATABASE_URL (lo toma del .env de la raíz), cada llamada a un proveedor real queda en
 * `ModelUsage` como `EVAL`, igual que «Evaluar» del panel, y sale en la vista «Consumo». El costo
 * del resumen usa MODEL_PRICES_USD. EVAL_RECORD_USAGE=false para no registrarlo.
 * Sale con código 1 si hay datos inventados o si los correctos son < 95 %.
 * El núcleo vive en `apps/worker/src/evals/suite.ts` (también lo usa el worker al publicar).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient, PrismaUsageRecorder, type PrismaClient } from '@abaya/db';
import type { AgentConfig, LlmPort, ModelUsage, UsageRecorder } from '@abaya/domain';
import { readCatalogFile, SYNTHETIC_CATALOG } from '../apps/worker/src/catalog/catalog.js';
import {
  gateFailures,
  loadCases,
  report,
  runSuite,
  summarize,
  type CaseResult,
} from '../apps/worker/src/evals/suite.js';
import { AnthropicLlmAdapter } from '../apps/worker/src/llm/adapters/anthropic.adapter.js';
import { GeminiLlmAdapter } from '../apps/worker/src/llm/adapters/gemini.adapter.js';
import { OpenAiLlmAdapter } from '../apps/worker/src/llm/adapters/openai.adapter.js';
import { ScriptedLlmAdapter } from '../apps/worker/src/llm/adapters/scripted.adapter.js';
import { heuristicBrain } from '../apps/worker/src/llm/adapters/heuristic-brain.js';
import { meteredLlm } from '../apps/worker/src/usage/metered.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// Catálogo SINTÉTICO por defecto; --catalogo <archivo.xlsx|.csv> evalúa otro (p. ej. el de Claro).
const catalogArg = process.argv.indexOf('--catalogo');
const catalogPlans = await readCatalogFile(
  catalogArg >= 0 && process.argv[catalogArg + 1]
    ? process.argv[catalogArg + 1]!
    : SYNTHETIC_CATALOG,
);

function adapterFor(provider: string): LlmPort {
  switch (provider) {
    case 'heuristic':
      return new ScriptedLlmAdapter(heuristicBrain);
    case 'anthropic':
      return new AnthropicLlmAdapter({
        model: process.env.EVAL_ANTHROPIC_MODEL ?? 'claude-opus-5-5',
      });
    case 'openai': {
      const model = process.env.EVAL_OPENAI_MODEL;
      if (!model) throw new Error('Falta EVAL_OPENAI_MODEL');
      return new OpenAiLlmAdapter({ model });
    }
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('Falta GEMINI_API_KEY');
      const model = process.env.EVAL_GEMINI_MODEL;
      return new GeminiLlmAdapter({ apiKey, ...(model ? { model } : {}) });
    }
    default:
      throw new Error(`proveedor desconocido: ${provider}`);
  }
}

/** Tarifas de MODEL_PRICES_USD (USD por millón); el modelo puede venir con versión («modelo-001»). */
type Prices = Record<string, { input: number; output: number }>;
function parsePrices(raw: string | undefined): Prices {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw) as Prices;
  } catch {
    console.error('MODEL_PRICES_USD no es un JSON válido: el costo no se calcula');
    return {};
  }
}
function priceFor(prices: Prices, model: string) {
  const key =
    prices[model] !== undefined
      ? model
      : Object.keys(prices)
          .filter((k) => model.startsWith(k))
          .sort((a, b) => b.length - a.length)[0];
  return key ? prices[key]! : null;
}

/** Suma por modelo y, si hay base, registra cada llamada como `EVAL` (sin contenido). */
class EvalUsage implements UsageRecorder {
  readonly byModel = new Map<string, { calls: number; input: number; output: number }>();
  /** Modelo con que respondió cada proveedor (para la columna «Costo/conv.» del reporte). */
  readonly modelOf = new Map<string, string>();
  constructor(private readonly db: PrismaUsageRecorder | null) {}
  record(u: ModelUsage): void {
    this.modelOf.set(u.provider, u.model);
    const t = this.byModel.get(u.model) ?? { calls: 0, input: 0, output: 0 };
    t.calls++;
    t.input += u.inputTokens;
    t.output += u.outputTokens;
    this.byModel.set(u.model, t);
    this.db?.record(u);
  }
}

function usageReport(usage: EvalUsage, prices: Prices, recorded: boolean): string {
  if (!usage.byModel.size) return '';
  let total = 0;
  let priced = true;
  const lines = [...usage.byModel].map(([model, t]) => {
    const p = priceFor(prices, model);
    const usd = p ? (t.input * p.input + t.output * p.output) / 1e6 : null;
    if (usd === null) priced = false;
    else total += usd;
    return (
      `  ${model}: ${t.calls} llamadas · ${t.input.toLocaleString('es-CO')} entrada · ` +
      `${t.output.toLocaleString('es-CO')} salida` +
      (usd === null ? ' · sin tarifa en MODEL_PRICES_USD' : ` · USD ${usd.toFixed(4)}`)
    );
  });
  return [
    '\nConsumo de la corrida:',
    ...lines,
    priced ? `  Costo estimado: USD ${total.toFixed(4)}` : '',
    recorded ? '  Registrado en «Consumo» como EVAL.' : '  No registrado (sin DATABASE_URL).',
  ]
    .filter(Boolean)
    .join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const providers = (arg('provider') ?? 'heuristic').split(',');
  const cases = loadCases(join(HERE, 'conversations'), arg('filter'));
  const concurrency = Number(arg('concurrency') ?? 4);
  const agentFile = arg('agent');
  const agent = agentFile
    ? (JSON.parse(readFileSync(agentFile, 'utf8')) as AgentConfig)
    : undefined;
  console.log(
    `Casos: ${cases.length} · proveedores: ${providers.join(', ')}` +
      (agent ? ` · agente v${agent.version}` : ''),
  );

  // Consumo (solo proveedores reales): a la base si hay DATABASE_URL, y siempre al resumen.
  const real = providers.some((p) => p !== 'heuristic');
  const dbUrl = process.env.DATABASE_URL;
  let prisma: PrismaClient | null = null;
  let dbUsage: PrismaUsageRecorder | null = null;
  if (real && dbUrl && process.env.EVAL_RECORD_USAGE !== 'false') {
    prisma = createPrismaClient(dbUrl);
    dbUsage = new PrismaUsageRecorder(prisma, (err) =>
      console.error(`consumo no registrado: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  const usage = new EvalUsage(dbUsage);

  const results: CaseResult[] = [];
  for (const p of providers) {
    results.push(
      ...(await runSuite(cases, {
        provider: p,
        llm: () => (p === 'heuristic' ? adapterFor(p) : meteredLlm(adapterFor(p), usage, 'EVAL')),
        plans: catalogPlans,
        concurrency,
        ...(agent ? { agent } : {}),
      })),
    );
  }

  // «Costo/conv.» del reporte: EVAL_PRICE_<PROVEEDOR>_IN/_OUT o, si faltan, MODEL_PRICES_USD.
  const prices = parsePrices(process.env.MODEL_PRICES_USD);
  for (const p of providers) {
    const model = usage.modelOf.get(p);
    const price = model ? priceFor(prices, model) : null;
    const key = `EVAL_PRICE_${p.toUpperCase()}`;
    if (price && process.env[`${key}_IN`] === undefined)
      process.env[`${key}_IN`] = String(price.input);
    if (price && process.env[`${key}_OUT`] === undefined)
      process.env[`${key}_OUT`] = String(price.output);
  }

  const md = report(results, providers);
  const outDir = join(HERE, 'reports');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `${stamp}.md`), md);
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(results, null, 2));
  console.log(md.split('\n## Por grupo')[0]);
  console.log(`\nReporte: evals/reports/${stamp}.md`);
  if (dbUsage) await dbUsage.flush();
  await prisma?.$disconnect();
  const summary = usageReport(usage, prices, dbUsage !== null);
  if (summary) console.log(summary);

  let fail = false;
  for (const p of providers) {
    for (const f of gateFailures(summarize(results, p))) {
      console.error(`✗ ${p}: ${f}`);
      fail = true;
    }
  }
  process.exit(fail ? 1 : 0);
}

void main();
