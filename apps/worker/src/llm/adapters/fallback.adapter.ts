import { LlmProviderError, type LlmPort, type LlmRequest, type LlmResponse } from '@abaya/domain';
import type { Logger } from '@abaya/logger';

/**
 * Proveedor de respaldo (v1.5, sección 6.3.6): si el principal falla (caído, timeout, cuota),
 * la misma solicitud va al respaldo. Si también falla, el error sube y la conversación pasa a
 * NEEDS_REVIEW como siempre. La salida del respaldo pasa por los mismos validadores.
 */
export class FallbackLlmAdapter implements LlmPort {
  readonly provider: string;

  constructor(
    private readonly primary: LlmPort,
    private readonly backup: LlmPort,
    private readonly logger: Logger,
  ) {
    this.provider = primary.provider;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.primary.complete(req);
      return { ...res, provider: res.provider ?? this.primary.provider };
    } catch (err) {
      if (!(err instanceof LlmProviderError)) throw err;
      this.logger.warn(
        { primary: this.primary.provider, backup: this.backup.provider, err: err.message },
        'proveedor principal falló: usando el respaldo',
      );
      // El modelo elegido en el panel es del proveedor principal: el respaldo usa el suyo.
      const { model: _primaryModel, ...forBackup } = req;
      const res = await this.backup.complete(forBackup);
      return { ...res, provider: res.provider ?? this.backup.provider };
    }
  }
}
