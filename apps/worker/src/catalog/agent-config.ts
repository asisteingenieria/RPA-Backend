import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '@abaya/domain';
import type { PrismaClient } from '@abaya/db';
import type { Logger } from '@abaya/logger';

interface AgentConfigRow {
  id: string;
  version: number;
  agentName: string;
  companyName: string;
  companyInfo: string;
  welcome: string;
  prompt: string;
  model: string | null;
  temperature: number;
}

export function agentConfigFromRow(r: AgentConfigRow): AgentConfig {
  return {
    id: r.id,
    version: r.version,
    agentName: r.agentName,
    companyName: r.companyName,
    companyInfo: r.companyInfo,
    welcome: r.welcome,
    prompt: r.prompt,
    model: r.model,
    temperature: r.temperature,
  };
}

/**
 * Versión PUBLICADA del agente (v1.8, sección 6.3.8), en memoria y releída cada 30 s: el motor
 * la consulta en cada turno sin ir a la base. Sin versión publicada (o si la base falla al
 * arrancar) se usa la v1 del código; si falla una relectura, se sigue con la última conocida.
 */
export class PrismaAgentConfigSource {
  private current: AgentConfig = DEFAULT_AGENT_CONFIG;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly refreshMs = 30_000,
  ) {}

  get(): AgentConfig {
    return this.current;
  }

  /** Versiones ya publicadas que siguen atendiendo conversaciones (no cambian: D-004). */
  private readonly pinned = new Map<string, AgentConfig>();

  /**
   * Versión de una conversación (D-004): la con la que empezó, aunque ya haya otra publicada.
   * Sin versión, o si no se encuentra, la publicada actual.
   */
  async resolve(id: string | undefined): Promise<AgentConfig> {
    if (!id || id === this.current.id) return this.current;
    if (id === DEFAULT_AGENT_CONFIG.id) return DEFAULT_AGENT_CONFIG;
    const cached = this.pinned.get(id);
    if (cached) return cached;
    try {
      const row = await this.prisma.agentConfigVersion.findUnique({ where: { id } });
      // Solo versiones que estuvieron publicadas (las demás pueden cambiar o nunca se usaron).
      if (row && (row.status === 'PUBLISHED' || row.status === 'ARCHIVED')) {
        const cfg = agentConfigFromRow(row);
        if (this.pinned.size > 50) this.pinned.clear();
        this.pinned.set(id, cfg);
        return cfg;
      }
      this.logger.warn(
        { id },
        'versión del agente de la conversación no disponible: se usa la publicada',
      );
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'no se pudo leer la versión del agente de la conversación: se usa la publicada',
      );
    }
    return this.current;
  }

  async refresh(): Promise<void> {
    try {
      const row = await this.prisma.agentConfigVersion.findFirst({
        where: { status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
      });
      const next = row ? agentConfigFromRow(row) : DEFAULT_AGENT_CONFIG;
      if (next.id !== this.current.id) {
        this.logger.info({ version: next.version, id: next.id }, 'versión del agente activa');
      }
      this.current = next;
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'no se pudo leer la versión del agente: se mantiene la anterior',
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
