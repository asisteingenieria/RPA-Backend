import type { AlertPort, AlertSeverity } from '@abaya/domain';
import { createLogger, type Logger } from '@abaya/logger';

/** Alertas a los logs (siempre activo). */
export class LogAlertAdapter implements AlertPort {
  constructor(private readonly logger: Logger = createLogger('alerts')) {}

  async raise(code: string, severity: AlertSeverity, detail: Record<string, unknown> = {}) {
    const level = severity === 'MEDIA' ? 'warn' : 'error';
    this.logger[level]({ alert: code, severity, ...detail }, `ALERTA ${severity}: ${code}`);
  }
}

/**
 * Alertas a un webhook entrante (Slack, Teams o similar): `{ "text": "..." }`.
 * Solo se envían códigos e identificadores, nunca datos personales (sección 8).
 */
export class WebhookAlertAdapter implements AlertPort {
  constructor(
    private readonly url: string,
    private readonly opts: {
      environment?: string;
      timeoutMs?: number;
      fetchFn?: typeof fetch;
    } = {},
  ) {}

  async raise(code: string, severity: AlertSeverity, detail: Record<string, unknown> = {}) {
    const icon = severity === 'CRITICA' ? '🔴' : severity === 'ALTA' ? '🟠' : '🟡';
    const env = this.opts.environment ? ` [${this.opts.environment}]` : '';
    const ids = Object.entries(detail)
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.slice(0, 10).join(', ') : String(v)}`)
      .join(' · ');
    const res = await (this.opts.fetchFn ?? fetch)(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${icon} *${severity}*${env} ${code}${ids ? `\n${ids}` : ''}` }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) throw new Error(`webhook de alertas respondió ${res.status}`);
  }
}

/** Envía a todos los canales; un canal caído no impide los demás. */
export class CompositeAlertAdapter implements AlertPort {
  constructor(
    private readonly targets: AlertPort[],
    private readonly logger: Logger = createLogger('alerts'),
  ) {}

  async raise(code: string, severity: AlertSeverity, detail?: Record<string, unknown>) {
    const results = await Promise.allSettled(
      this.targets.map((t) => t.raise(code, severity, detail)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger.error(
          { alert: code, err: r.reason instanceof Error ? r.reason.message : 'error' },
          'canal de alertas falló',
        );
      }
    }
  }
}

/** Para pruebas: guarda las alertas en memoria. */
export class MemoryAlertAdapter implements AlertPort {
  readonly raised: { code: string; severity: AlertSeverity; detail?: Record<string, unknown> }[] =
    [];

  async raise(code: string, severity: AlertSeverity, detail?: Record<string, unknown>) {
    this.raised.push({ code, severity, ...(detail ? { detail } : {}) });
  }
}

export function alertsFromConfig(
  cfg: { ALERT_WEBHOOK_URL?: string; NODE_ENV: string },
  logger?: Logger,
): AlertPort {
  const targets: AlertPort[] = [new LogAlertAdapter(logger)];
  if (cfg.ALERT_WEBHOOK_URL)
    targets.push(new WebhookAlertAdapter(cfg.ALERT_WEBHOOK_URL, { environment: cfg.NODE_ENV }));
  return new CompositeAlertAdapter(targets, logger);
}
