import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@abaya/db';
import {
  CatalogTableParser,
  detectFile,
  formatIssue,
  loadAgentCatalog,
  pickData,
  queryPlans,
  recordHash,
  validateCatalog,
  type CatalogRecordData,
  type PlanQueryResult,
  type SaleProcess,
} from '@abaya/knowledge';
import type { Logger } from '@abaya/logger';

/**
 * Catálogo de planes (v1.9): la versión PUBLICADA del Brain de catálogo conectado al agente
 * (docs/DECISIONS.md D-001). ÚNICA fuente de planes y precios (regla 11): los textos y el
 * precio de la ficha salen literalmente de estos registros.
 */
export interface Plan extends CatalogRecordData {
  /** sha256 del registro (trazabilidad de lo que vio el cliente). */
  hash: string;
}

/** De qué Brain y versión salió una consulta. */
export interface CatalogSourceRef {
  brainId: string;
  brainName: string;
  versionId: string;
  version: number;
}

export type CatalogQuery = PlanQueryResult<Plan> & { source: CatalogSourceRef | null };

export interface Catalog {
  /**
   * `consultar_planes(proceso)`: la llama el CÓDIGO con el proceso que fijó la máquina de
   * estados, nunca el modelo. Filtro exacto por proceso; sin planes → `SIN_PLANES` explícito.
   */
  query(process: SaleProcess): Promise<CatalogQuery>;
  get(code: string): Promise<Plan | undefined>;
}

export function toPlan(r: CatalogRecordData): Plan {
  return { ...pickData(r), hash: recordHash(r) };
}

/** Catálogo fijo (pruebas, suite de evaluación con un borrador, CLI de evals). */
export class MemoryCatalog implements Catalog {
  private readonly plans: Plan[];

  constructor(
    records: readonly CatalogRecordData[],
    private readonly source: CatalogSourceRef | null = null,
  ) {
    this.plans = records.map(toPlan);
  }

  async query(process: SaleProcess): Promise<CatalogQuery> {
    return { ...queryPlans(this.plans, process), source: this.source };
  }

  async get(code: string) {
    return this.plans.find((p) => p.code === code);
  }

  all(): Plan[] {
    return [...this.plans];
  }
}

/**
 * Versión publicada del Brain de catálogo del agente, en memoria y releída cada 30 s (D4):
 * un precio publicado llega a más tardar al siguiente turno. Si una relectura falla se sigue
 * con la última conocida; sin catálogo publicado, toda consulta da `SIN_PLANES`.
 */
export class PublishedBrainCatalog implements Catalog {
  private current: MemoryCatalog = new MemoryCatalog([]);
  private ref: CatalogSourceRef | null = null;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly refreshMs = 30_000,
  ) {}

  query(process: SaleProcess) {
    return this.current.query(process);
  }

  get(code: string) {
    return this.current.get(code);
  }

  source(): CatalogSourceRef | null {
    return this.ref;
  }

  async refresh(): Promise<void> {
    try {
      const c = await loadAgentCatalog(this.prisma);
      const ref = c
        ? { brainId: c.brainId, brainName: c.brainName, versionId: c.versionId, version: c.version }
        : null;
      if (ref?.versionId !== this.ref?.versionId) {
        this.logger.info(
          ref ? { brain: ref.brainName, version: ref.version } : { brain: null },
          ref ? 'catálogo publicado activo' : 'sin catálogo publicado: no se ofrecerán planes',
        );
      }
      this.ref = ref;
      this.current = new MemoryCatalog(c?.records ?? [], ref);
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'no se pudo leer el catálogo publicado: se mantiene el anterior',
      );
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Lee y valida un archivo de catálogo (Excel o CSV) del disco: seed, pruebas y CLI de evals. */
export async function readCatalogFile(path: string | URL): Promise<CatalogRecordData[]> {
  const file = typeof path === 'string' ? path : fileURLToPath(path);
  const bytes = new Uint8Array(readFileSync(file));
  const detected = await detectFile(bytes, file, ['xlsx', 'csv']);
  const { table } = await new CatalogTableParser().parse(bytes, detected.kind as 'xlsx' | 'csv');
  const v = validateCatalog(table);
  if (!v.ok) throw new Error(`catálogo inválido: ${v.errors.map(formatIssue).join(' · ')}`);
  return v.records;
}

/** Catálogo SINTÉTICO de desarrollo (no son planes ni precios reales de Claro). */
export const SYNTHETIC_CATALOG = new URL('./plans.synthetic.csv', import.meta.url);
