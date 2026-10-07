/**
 * Suite de evaluación del motor de conversación (sección 12.1).
 *
 *   pnpm evals                                  # línea base heurística (sin red)
 *   pnpm evals --provider anthropic,openai      # proveedores reales (requiere API keys)
 *   pnpm evals --provider anthropic --filter feliz-
 *   pnpm evals --provider anthropic --agent borrador.json   # una versión del agente (v1.8)
 *
 * Variables: EVAL_ANTHROPIC_MODEL (por defecto claude-opus-5-5), EVAL_OPENAI_MODEL,
 * EVAL_PRICE_<PROVEEDOR>_IN / _OUT (USD por millón de tokens) para el costo.
 * Sale con código 1 si hay datos inventados o si los correctos son < 95 %.
 * El núcleo vive en `apps/worker/src/evals/suite.ts` (también lo usa el worker al publicar).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig, LlmPort } from '@abaya/domain';
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
import { OpenAiLlmAdapter } from '../apps/worker/src/llm/adapters/openai.adapter.js';
import { ScriptedLlmAdapter } from '../apps/worker/src/llm/adapters/scripted.adapter.js';
import { heuristicBrain } from '../apps/worker/src/llm/adapters/heuristic-brain.js';

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
    default:
      throw new Error(`proveedor desconocido: ${provider}`);
  }
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

  const results: CaseResult[] = [];
  for (const p of providers) {
    results.push(
      ...(await runSuite(cases, {
        provider: p,
        llm: () => adapterFor(p),
        plans: catalogPlans,
        concurrency,
        ...(agent ? { agent } : {}),
      })),
    );
  }

  const md = report(results, providers);
  const outDir = join(HERE, 'reports');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `${stamp}.md`), md);
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(results, null, 2));
  console.log(md.split('\n## Por grupo')[0]);
  console.log(`\nReporte: evals/reports/${stamp}.md`);

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
