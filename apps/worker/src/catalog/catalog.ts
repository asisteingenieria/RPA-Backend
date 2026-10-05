import type { PrismaClient } from '@abaya/db';
import { z } from 'zod';
import type { SaleProcess } from '../engine/types.js';

/** Catálogo: ÚNICA fuente de planes y precios (modelo `Plan`, sección 5). */
export const planSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/, 'código en mayúsculas, p. ej. M1'),
  process: z.enum(['PORTABILIDAD', 'MIGRACION', 'LINEA_NUEVA']),
  name: z.string().min(1).max(80),
  dataGb: z.number().int().positive(),
  priceCop: z.number().int().positive(),
  discountText: z.string().max(300).nullable().optional(),
  benefits: z.array(z.string().min(1).max(120)).max(10),
  active: z.boolean().default(true),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date().nullable().optional(),
});

export type Plan = z.infer<typeof planSchema>;

export const catalogFileSchema = z
  .object({ plans: z.array(planSchema).min(1) })
  .refine((c) => new Set(c.plans.map((p) => p.code)).size === c.plans.length, {
    message: 'códigos de plan duplicados',
  });

export interface Catalog {
  /** Planes activos y vigentes del proceso, ordenados por precio. */
  plansFor(process: SaleProcess, at?: Date): Promise<Plan[]>;
  get(code: string): Promise<Plan | undefined>;
}

export function isPlanAvailable(p: Plan, process: SaleProcess, at: Date): boolean {
  return (
    p.active &&
    p.process === process &&
    p.validFrom.getTime() <= at.getTime() &&
    (!p.validTo || p.validTo.getTime() > at.getTime())
  );
}

export class MemoryCatalog implements Catalog {
  constructor(private readonly plans: Plan[]) {}

  async plansFor(process: SaleProcess, at = new Date()) {
    return this.plans
      .filter((p) => isPlanAvailable(p, process, at))
      .sort((a, b) => a.priceCop - b.priceCop);
  }

  async get(code: string) {
    return this.plans.find((p) => p.code === code);
  }
}

export class PrismaCatalog implements Catalog {
  constructor(private readonly prisma: PrismaClient) {}

  async plansFor(process: SaleProcess, at = new Date()) {
    const rows = await this.prisma.plan.findMany({
      where: {
        process,
        active: true,
        validFrom: { lte: at },
        OR: [{ validTo: null }, { validTo: { gt: at } }],
      },
      orderBy: { priceCop: 'asc' },
    });
    return rows.map((r) => planSchema.parse(r));
  }

  async get(code: string) {
    const r = await this.prisma.plan.findUnique({ where: { code } });
    return r ? planSchema.parse(r) : undefined;
  }
}
