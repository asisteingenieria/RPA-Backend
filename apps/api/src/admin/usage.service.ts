import type { ModelPrices } from '@abaya/config';
import { Prisma, type PrismaClient } from '@abaya/db';
import { parseFilters } from './conversations.service.js';

/** Usos que muestra la vista: conversaciones (`LlmCall`) + los de `ModelUsage`. */
export type UsageUse = 'CHAT' | 'VOICE' | 'IMAGE_READ' | 'EMBEDDING' | 'EVAL' | 'TEST';

interface Row {
  day: string;
  kind: UsageUse;
  provider: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  estimated: boolean;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null: algún modelo del grupo no tiene tarifa configurada. */
  costUsd: number | null;
  estimated: boolean;
}

const n = (v: unknown) => Number(v ?? 0);

/**
 * Vista «Consumo» del panel: tokens por uso, modelo y día (día de Bogotá), y costo ESTIMADO con
 * la tarifa de MODEL_PRICES_USD. Solo cifras: ningún contenido. La factura oficial es la del
 * proveedor (la API key no da acceso al estado de cuenta).
 */
export class UsageService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly prices: ModelPrices,
  ) {}

  async summary(q: Record<string, unknown>) {
    const { range, from, to } = parseFilters({ range: q.range, from: q.from, to: q.to });
    // Día de Bogotá (UTC-5, sin horario de verano).
    const [chat, other, convs, sales] = await Promise.all([
      this.prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT to_char("createdAt" - interval '5 hours', 'YYYY-MM-DD') AS day, provider, model,
               count(*) AS calls, sum("inputTokens") AS input, sum("outputTokens") AS output
        FROM "LlmCall" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY 1, 2, 3`),
      this.prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT to_char("createdAt" - interval '5 hours', 'YYYY-MM-DD') AS day, kind::text AS kind,
               provider, model, count(*) AS calls, sum("inputTokens") AS input,
               sum("outputTokens") AS output, bool_or(estimated) AS estimated
        FROM "ModelUsage" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY 1, 2, 3, 4`),
      this.prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT count(DISTINCT "conversationId") AS count,
               sum("inputTokens" + "outputTokens") AS tokens
        FROM "LlmCall" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}`),
      // Ventas del rango con lo que gastaron sus conversaciones completas.
      this.prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT count(*) AS count,
               coalesce(sum(t.tokens), 0) AS tokens
        FROM "Sale" s
        LEFT JOIN (SELECT "conversationId", sum("inputTokens" + "outputTokens") AS tokens
                   FROM "LlmCall" GROUP BY 1) t ON t."conversationId" = s."conversationId"
        WHERE s."createdAt" >= ${from} AND s."createdAt" < ${to}`),
    ]);

    const rows: Row[] = [
      ...chat.map((r) => ({
        day: String(r.day),
        kind: 'CHAT' as const,
        provider: String(r.provider),
        model: String(r.model),
        calls: n(r.calls),
        input: n(r.input),
        output: n(r.output),
        estimated: false,
      })),
      ...other.map((r) => ({
        day: String(r.day),
        kind: String(r.kind) as UsageUse,
        provider: String(r.provider),
        model: String(r.model),
        calls: n(r.calls),
        input: n(r.input),
        output: n(r.output),
        estimated: r.estimated === true,
      })),
    ];

    const add = (key: string, map: Map<string, UsageTotals>, r: Row) => {
      const t: UsageTotals = map.get(key) ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        estimated: false,
      };
      t.calls += r.calls;
      t.inputTokens += r.input;
      t.outputTokens += r.output;
      t.estimated ||= r.estimated;
      const cost = this.cost(r.model, r.input, r.output);
      t.costUsd = t.costUsd === null || cost === null ? null : t.costUsd + cost;
      map.set(key, t);
    };
    const total = new Map<string, UsageTotals>();
    const byKind = new Map<string, UsageTotals>();
    const byModel = new Map<string, UsageTotals>();
    const byDay = new Map<string, UsageTotals>();
    for (const r of rows) {
      add('total', total, r);
      add(r.kind, byKind, r);
      add(`${r.provider}\u0000${r.model}`, byModel, r);
      add(`${r.day}\u0000${r.kind}`, byDay, r);
    }
    const empty: UsageTotals = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      estimated: false,
    };
    const convCount = n(convs[0]?.count);
    const saleCount = n(sales[0]?.count);
    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      totals: total.get('total') ?? empty,
      byKind: [...byKind].map(([kind, t]) => ({ kind: kind as UsageUse, ...t })),
      byModel: [...byModel]
        .map(([k, t]) => {
          const [provider, model] = k.split('\u0000') as [string, string];
          return { provider, model, priced: this.price(model) !== null, ...t };
        })
        .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
      byDay: [...byDay]
        .map(([k, t]) => {
          const [day, kind] = k.split('\u0000') as [string, UsageUse];
          return { day, kind, tokens: t.inputTokens + t.outputTokens, calls: t.calls };
        })
        .sort((a, b) => a.day.localeCompare(b.day)),
      conversations: {
        count: convCount,
        avgTokens: convCount ? Math.round(n(convs[0]?.tokens) / convCount) : null,
      },
      sales: {
        count: saleCount,
        avgTokens: saleCount ? Math.round(n(sales[0]?.tokens) / saleCount) : null,
      },
      prices: { configured: Object.keys(this.prices).length > 0, models: Object.keys(this.prices) },
    };
  }

  /** Tarifa del modelo (el proveedor puede responder con una versión: «modelo-001»). */
  private price(model: string) {
    if (this.prices[model]) return this.prices[model];
    const key = Object.keys(this.prices)
      .filter((k) => model.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return key ? this.prices[key]! : null;
  }

  private cost(model: string, input: number, output: number): number | null {
    const p = this.price(model);
    return p ? (input * p.input + output * p.output) / 1_000_000 : null;
  }
}
