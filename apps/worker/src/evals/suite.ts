/**
 * Núcleo de la suite de evaluación del motor (sección 12.1). Lo usan el CLI `pnpm evals`
 * (`evals/run-evals.ts`) y el worker al publicar una versión del agente (v1.8, regla 13).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, LlmPort } from '@abaya/domain';
import { STAGES } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { CatalogRecordData } from '@abaya/knowledge';
import { MemoryCatalog, toPlan, type Plan } from '../catalog/catalog.js';
import { MemoryConversationStore } from '../conversation/memory.store.js';
import { TurnService } from '../conversation/turn.service.js';
import { ConversationEngine, type TurnKnowledge } from '../engine/conversation-engine.js';
import * as T from '../engine/templates/templates.js';
import { FORBIDDEN_PROMISES } from '../engine/validators/validators.js';

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
      /** v1.9: el bot mostró al menos una ficha con precio (y todos los precios son del catálogo). */
      pricesShown: z.boolean().optional(),
    })
    .strict(),
});
const fileSchema = z.object({ group: z.string(), cases: z.array(caseSchema) });
export type EvalCase = z.infer<typeof caseSchema> & { group: string };

export interface CaseResult {
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

export function loadCases(dir: string, filter?: string): EvalCase[] {
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

// ---------- chequeos globales ----------

const EXPLICIT_YES =
  /^\s*(s[ií]\s*,?\s*(lo\s+)?autorizo|autorizo|acepto(\s+la\s+autorizaci[oó]n)?)\s*[.!]*\s*$/i;

/** Quita de un mensaje todo el texto que proviene de plantillas del código. */
function stripTemplates(text: string, now: Date, plans: Plan[], agent?: AgentConfig): string {
  let t = text;
  const fixed = [
    agent ? T.menu(agent.welcome) : T.MENU,
    T.SUPPORT,
    T.SAFE_FALLBACK,
    T.TRANSFER,
    T.NO_SALE_GOODBYE,
    T.ESCALATE,
    T.authorization(now),
    T.offerList(plans.filter((p) => p.process === 'PORTABILIDAD')),
    T.offerList(plans.filter((p) => p.process === 'MIGRACION')),
    T.offerList(plans.filter((p) => p.process === 'LINEA_NUEVA')),
    ...plans.map(T.offer),
  ];
  for (const f of fixed) t = t.split(f).join(' ');
  return t;
}

/** Precios en pesos que aparecen en un texto ("$59.900"). */
export function pricesIn(text: string): string[] {
  return [...text.matchAll(/\$\s?\d{1,3}(?:\.\d{3})+|\$\s?\d+/g)].map((m) =>
    m[0].replace(/\s/g, ''),
  );
}

function globalChecks(
  transcript: CaseResult['transcript'],
  sale: boolean,
  now: Date,
  plans: Plan[],
  agent?: AgentConfig,
  process?: string,
): string[] {
  const errs: string[] = [];
  // v1.9: todo precio mostrado es LITERAL del catálogo publicado y del proceso del cliente.
  const allowed = new Set(
    plans.filter((p) => p.process === process).map((p) => T.formatCop(p.priceCop)),
  );
  for (const m of transcript.filter((x) => x.role === 'bot')) {
    for (const price of pricesIn(m.text)) {
      if (!allowed.has(price)) {
        errs.push(
          `INVENTADO: precio ${price} no está en el catálogo de ${process ?? 'ningún proceso'}`,
        );
      }
    }
    if (m.text.includes('{{')) errs.push('INVENTADO: marcador sin reemplazar');
    const free = stripTemplates(m.text, now, plans, agent);
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

export interface RunOptions {
  /** Nombre del proveedor en el reporte. */
  provider: string;
  llm: () => LlmPort;
  /** Registros del catálogo a evaluar (publicado o borrador del Brain). */
  plans: readonly CatalogRecordData[];
  /** Versión del agente a evaluar; sin ella, la v1 del código. */
  agent?: AgentConfig;
  /** v1.9: documentos de los Brains (contexto completo y búsqueda) que ve el modelo. */
  knowledge?: TurnKnowledge;
  concurrency?: number;
}

export async function runCase(c: EvalCase, o: RunOptions): Promise<CaseResult> {
  const now = new Date();
  const store = new MemoryConversationStore();
  const catalog = new MemoryCatalog(o.plans);
  const agent = o.agent;
  const engine = new ConversationEngine({
    llm: o.llm(),
    catalog,
    now: () => now,
    ...(agent ? { agentConfig: () => agent } : {}),
    ...(o.knowledge ? { knowledge: o.knowledge } : {}),
  });
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
  if (e.pricesShown && !transcript.some((m) => m.role === 'bot' && pricesIn(m.text).length)) {
    failures.push('no se mostró ninguna ficha con precio');
  }
  const global = globalChecks(
    transcript,
    sale,
    now,
    o.plans.map(toPlan),
    agent,
    conv.profile.process,
  );
  failures.push(...global);

  return {
    id: c.id,
    group: c.group,
    provider: o.provider,
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

export function runSuite(cases: EvalCase[], o: RunOptions): Promise<CaseResult[]> {
  return pool(cases, o.concurrency ?? 4, (c) => runCase(c, o));
}

// ---------- reporte ----------

export const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + ' %' : '—');
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

export interface SuiteSummary {
  provider: string;
  cases: number;
  passed: number;
  invented: number;
  regenRate: string;
  fallbackRate: string;
  p50: number;
  p95: number;
  costPerConversation: number;
}

export function summarize(results: CaseResult[], provider: string): SuiteSummary {
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

/** Meta de la sección F5: 0 datos inventados y ≥ 95 % de casos correctos. */
export function gateFailures(s: SuiteSummary): string[] {
  const out: string[] = [];
  if (!s.cases) out.push('no hay casos de evaluación');
  if (s.invented > 0) out.push(`${s.invented} casos con datos inventados (meta 0)`);
  if (s.cases && s.passed / s.cases < 0.95)
    out.push(`${pct(s.passed, s.cases)} correctos (meta ≥ 95 %)`);
  return out;
}

export function report(results: CaseResult[], providers: string[]): string {
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
