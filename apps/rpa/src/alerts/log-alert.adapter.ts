import type { AlertPort, AlertSeverity } from '@abaya/domain';
import { createLogger, type Logger } from '@abaya/logger';

/**
 * Adaptador de alertas por log. Los canales reales (correo, Slack, Teams) se agregan en F7
 * como otros adaptadores del mismo puerto.
 */
export class LogAlertAdapter implements AlertPort {
  constructor(private readonly logger: Logger = createLogger('alerts')) {}

  async raise(code: string, severity: AlertSeverity, detail: Record<string, unknown> = {}) {
    const level = severity === 'MEDIA' ? 'warn' : 'error';
    this.logger[level]({ alert: code, severity, ...detail }, `ALERTA ${severity}: ${code}`);
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
