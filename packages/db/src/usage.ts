import type { PrismaClient, UsageKind } from './generated/prisma/client.js';

/** Un registro de consumo (misma forma que `ModelUsage` de @abaya/domain). */
export interface ModelUsageRow {
  kind: UsageKind;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number | null;
  estimated?: boolean;
}

/**
 * Guarda el consumo de tokens sin esperar ni romper el trabajo: si la base falla, solo se pierde
 * esa cifra (la vista «Consumo» es informativa; la factura oficial es la del proveedor).
 */
export class PrismaUsageRecorder {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  record(u: ModelUsageRow): void {
    const clean = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
    void this.prisma.modelUsage
      .create({
        data: {
          kind: u.kind,
          provider: u.provider.slice(0, 40),
          model: u.model.slice(0, 120),
          inputTokens: clean(u.inputTokens),
          outputTokens: clean(u.outputTokens),
          latencyMs: u.latencyMs === null ? null : clean(u.latencyMs),
          estimated: u.estimated ?? false,
        },
      })
      .catch(this.onError);
  }
}
