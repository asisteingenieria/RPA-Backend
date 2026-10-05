/**
 * Suite de evaluación del motor de conversación (sección 12.1).
 *
 *   pnpm evals                                  # línea base heurística (sin red)
 *   pnpm evals --provider anthropic,openai      # proveedores reales (requiere API keys)
 *   pnpm evals --provider anthropic --filter feliz-
 *
 * Variables: EVAL_ANTHROPIC_MODEL (por defecto claude-opus-5-5), EVAL_OPENAI_MODEL,
 * EVAL_PRICE_<PROVEEDOR>_IN / _OUT (USD por millón de tokens) para el costo.
 * Sale con código 1 si hay datos inventados o si los correctos son < 95 %.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmPort } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { MemoryCatalog, catalogFileSchema } from '../apps/worker/src/catalog/catalog.js';
import { MemoryConversationStore } from '../apps/worker/src/conversation/memory.store.js';
import { TurnService } from '../apps/worker/src/conversation/turn.service.js';
import { ConversationEngine } from '../apps/worker/src/engine/conversation-engine.js';
import * as T from '../apps/worker/src/engine/templates/templates.js';
import { FORBIDDEN_PROMISES } from '../apps/worker/src/engine/validators/validators.js';
import { AnthropicLlmAdapter } from '../apps/worker/src/llm/adapters/anthropic.adapter.js';
import { OpenAiLlmAdapter } from '../apps/worker/src/llm/adapters/openai.adapter.js';
import { ScriptedLlmAdapter } from '../apps/worker/src/llm/adapters/scripted.adapter.js';
import { heuristicBrain } from './heuristic-brain.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STAGES = [
  'MENU',
  'PERFIL',
  'OFERTA',
  'OBJECIONES',
  'AUTORIZACION',
  'TRANSFERENCIA',
  'SOPORTE',
  'CIERRE_SIN_VENTA',
  'ESCALAR',
] as const;

const caseSchema = z.object({
  id: z.string(),
  turns: z.array(z.string()).min(1),
  expect: z
    .object({
      finalStage: z.enum(STAGES).optional(),
      finalStageIn: z.array(z.enum(STAGES)).optional(),
      process: z.enum(['PORTABILIDAD', 'MIGRACION', 'LINEA_NUEVA']).optional(),
      sale: z.boolean().optional(),
      forbidden: z.array(z.string()).optional(),
    })
    .strict(),
});
const fileSchema = z.object({ group: z.string(), cases: z.array(caseSchema) });
type EvalCase = z.infer<typeof caseSchema> & { group: string };

interface CaseResult {
  id: string;
  group: string;
  provider: string;
  passed: boolean;
  invented: boolean;
  failures: string[];
  finalStage: string;
  llmCalls: number;
  regenerated: number;
  fallbacks: number;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
  transcript: { role: 'cliente' | 'bot'; text: string }[];
}

// ---------- carga ----------

function loadCases(filter?: string): EvalCase[] {
  const dir = join(HERE, 'conversations');
  const out: EvalCase[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.yaml'))
    .sort()) {
    const parsed = fileSchema.parse(parseYaml(readFileSync(join(dir, f), 'utf8')));
    for (const c of parsed.cases) out.push({ ...c, group: parsed.group });
  }
  const ids = new Set<string>();
  for (const c of out) {
    if (ids.has(c.id)) throw new Error(`caso duplicado: ${c.id}`);
    ids.add(c.id);
  }
  return filter ? out.filter((c) => c.id.includes(filter)) : out;
}

const catalogPlans = catalogFileSchema.parse(
  JSON.parse(readFileSync(join(HERE, '../apps/worker/src/catalog/plans.synthetic.json'), 'utf8')),
).plans;

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

// ---------- chequeos globales ----------

const EXPLICIT_YES =
  /^\s*(s[ií]\s*,?\s*(lo\s+)?autorizo|autorizo|acepto(\s+la\s+autorizaci[oó]n)?)\s*[.!]*\s*$/i;

/** Quita de un mensaje todo el texto que proviene de plantillas del código. */
function stripTemplates(text: string, now: Date): string {
  let t = text;
  const fixed = [
    T.MENU,
    T.SUPPORT,
    T.SAFE_FALLBACK,
    T.TRANSFER,
    T.NO_SALE_GOODBYE,
    T.ESCALATE,
    T.authorization(now),
    T.offerList(catalogPlans.filter((p) => p.process === 'PORTABILIDAD' && p.active)),
    T.offerList(catalogPlans.filter((p) => p.process === 'MIGRACION' && p.active)),
    T.offerList(catalogPlans.filter((p) => p.process === 'LINEA_NUEVA' && p.active)),
    ...catalogPlans.map(T.offer),
  ];
  for (const f of fixed) t = t.split(f).join(' ');
  return t;
}

function globalChecks(transcript: CaseResult['transcript'], sale: boolean, now: Date): string[] {
  const errs: string[] = [];
  for (const m of transcript.filter((x) => x.role === 'bot')) {
    if (m.text.includes('{{')) errs.push('INVENTADO: marcador sin reemplazar');
    const free = stripTemplates(m.text, now);
    if (/\d|[$%]|\b(gb|gigas?|megas?)\b/i.test(free))
      errs.push(`INVENTADO: cifra fuera de plantilla: "${free.trim().slice(0, 80)}"`);
    for (const p of FORBIDDEN_PROMISES) {
      if (free.toLowerCase().includes(p)) errs.push(`INVENTADO: promesa prohibida "${p}"`);
    }
  }
  if (sale && !transcript.some((m) => m.role === 'cliente' && EXPLICIT_YES.test(m.text))) {
    errs.push('INVENTADO: venta sin autorización explícita');
  }
  return errs;
}

// ---------- ejecución ----------

async function runCase(c: EvalCase, provider: string): Promise<CaseResult> {
  const now = new Date();
  const llm = adapterFor(provider);
  const store = new MemoryConversationStore();
  const catalog = new MemoryCatalog(catalogPlans);
  const engine = new ConversationEngine({ llm, catalog, now: () => now });
  const svc = new TurnService({
    store,
    engine,
    catalog,
    alerts: { raise: async () => undefined },
    logger: createLogger('evals', { level: 'silent' }),
    now: () => now,
  });
  store.create(c.id);
  const transcript: CaseResult['transcript'] = [];
  for (const turn of c.turns) {
    store.addInbound(c.id, turn);
    transcript.push({ role: 'cliente', text: turn });
    const before = store.outboundTexts(c.id).length;
    await svc.handle(c.id);
    for (const t of store.outboundTexts(c.id).slice(before))
      transcript.push({ role: 'bot', text: t });
  }

  const conv = store.get(c.id);
  const sale = store.sales.length > 0;
  const failures: string[] = [];
  const e = c.expect;
  if (e.finalStage && conv.stage !== e.finalStage)
    failures.push(`estado final ${conv.stage} ≠ ${e.finalStage}`);
  if (e.finalStageIn && !e.finalStageIn.includes(conv.stage as never)) {
    failures.push(`estado final ${conv.stage} ∉ [${e.finalStageIn.join(', ')}]`);
  }
  if (e.process && conv.profile.process !== e.process)
    failures.push(`proceso ${conv.profile.process} ≠ ${e.process}`);
  if (e.sale !== undefined && sale !== e.sale) failures.push(`venta ${sale} ≠ ${e.sale}`);
  for (const f of e.forbidden ?? []) {
    if (
      transcript.some((m) => m.role === 'bot' && m.text.toLowerCase().includes(f.toLowerCase()))
    ) {
      failures.push(`frase prohibida: "${f}"`);
    }
  }
  const global = globalChecks(transcript, sale, now);
  failures.push(...global);

  return {
    id: c.id,
    group: c.group,
    provider,
    passed: failures.length === 0,
    invented: global.length > 0,
    failures,
    finalStage: conv.stage,
    llmCalls: store.llmCalls.length,
    regenerated: store.llmCalls.filter((x) => x.validationResult === 'REGENERATED').length,
    fallbacks: store.llmCalls.filter((x) => x.validationResult === 'FALLBACK').length,
    latencies: store.llmCalls.map((x) => x.latencyMs),
    inputTokens: store.llmCalls.reduce((a, x) => a + x.inputTokens, 0),
    outputTokens: store.llmCalls.reduce((a, x) => a + x.outputTokens, 0),
    transcript,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

// ---------- reporte ----------

const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + ' %' : '—');
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

function summarize(results: CaseResult[], provider: string) {
  const rs = results.filter((r) => r.provider === provider);
  const lat = rs.flatMap((r) => r.latencies);
  const calls = rs.reduce((a, r) => a + r.llmCalls, 0);
  const inP = Number(
    process.env[`EVAL_PRICE_${provider.toUpperCase()}_IN`] ?? (provider === 'anthropic' ? 4 : 0),
  );
  const outP = Number(
    process.env[`EVAL_PRICE_${provider.toUpperCase()}_OUT`] ?? (provider === 'anthropic' ? 20 : 0),
  );
  const cost = rs.reduce((a, r) => a + (r.inputTokens * inP + r.outputTokens * outP) / 1e6, 0);
  return {
    provider,
    cases: rs.length,
    passed: rs.filter((r) => r.passed).length,
    invented: rs.filter((r) => r.invented).length,
    regenRate: pct(
      rs.reduce((a, r) => a + r.regenerated + r.fallbacks, 0),
      calls,
    ),
    fallbackRate: pct(
      rs.reduce((a, r) => a + r.fallbacks, 0),
      calls,
    ),
    p50: quantile(lat, 0.5),
    p95: quantile(lat, 0.95),
    costPerConversation: rs.length ? cost / rs.length : 0,
  };
}

function report(results: CaseResult[], providers: string[]): string {
  const lines = ['# Reporte de evaluación del motor', '', `Fecha: ${new Date().toISOString()}`, ''];
  lines.push(
    '| Proveedor | Correctos | Datos inventados (meta 0) | Regeneración | Fallback | Latencia p50 | p95 | Costo/conv. (USD) |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const p of providers) {
    const s = summarize(results, p);
    lines.push(
      `| ${p} | ${s.passed}/${s.cases} (${pct(s.passed, s.cases)}) | ${s.invented} (${pct(s.invented, s.cases)}) | ${s.regenRate} | ${s.fallbackRate} | ${s.p50} ms | ${s.p95} ms | ${s.costPerConversation.toFixed(4)} |`,
    );
  }
  lines.push('', '## Por grupo', '', '| Proveedor | Grupo | Correctos |', '|---|---|---|');
  for (const p of providers) {
    const groups = [...new Set(results.map((r) => r.group))];
    for (const g of groups) {
      const rs = results.filter((r) => r.provider === p && r.group === g);
      lines.push(`| ${p} | ${g} | ${rs.filter((r) => r.passed).length}/${rs.length} |`);
    }
  }
  const failed = results.filter((r) => !r.passed);
  if (failed.length) {
    lines.push('', '## Casos fallidos', '');
    for (const r of failed) {
      lines.push(`### ${r.provider} · ${r.id} (estado final ${r.finalStage})`, '');
      for (const f of r.failures) lines.push(`- ${f}`);
      lines.push('', '<details><summary>Transcripción</summary>', '');
      for (const m of r.transcript) lines.push(`**${m.role}:** ${m.text.replace(/\n/g, ' ⏎ ')}  `);
      lines.push('', '</details>', '');
    }
  }
  return lines.join('\n');
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const providers = (arg('provider') ?? 'heuristic').split(',');
  const cases = loadCases(arg('filter'));
  const concurrency = Number(arg('concurrency') ?? 4);
  console.log(`Casos: ${cases.length} · proveedores: ${providers.join(', ')}`);

  const results: CaseResult[] = [];
  for (const p of providers) {
    results.push(...(await pool(cases, concurrency, (c) => runCase(c, p))));
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
    const s = summarize(results, p);
    if (s.invented > 0) {
      console.error(`✗ ${p}: ${s.invented} casos con datos inventados (meta 0)`);
      fail = true;
    }
    if (s.passed / s.cases < 0.95) {
      console.error(`✗ ${p}: ${pct(s.passed, s.cases)} correctos (meta ≥ 95 %)`);
      fail = true;
    }
  }
  process.exit(fail ? 1 : 0);
}

void main();
