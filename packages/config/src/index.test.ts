import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadConfig', () => {
  it('aplica valores por defecto', () => {
    const cfg = loadConfig(valid);
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.RPA_PORT).toBe(3001);
    expect(cfg.ABAYA_USER).toBeUndefined();
  });

  it('trata cadenas vacías como no definidas', () => {
    expect(loadConfig({ ...valid, ABAYA_PASSWORD: '' }).ABAYA_PASSWORD).toBeUndefined();
  });

  it('rechaza una clave de cifrado de longitud incorrecta', () => {
    expect(() => loadConfig({ ...valid, FIELD_ENCRYPTION_KEY: 'abc' })).toThrow(
      /FIELD_ENCRYPTION_KEY/,
    );
  });

  it('no incluye valores secretos en el error', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'secreto-no-url' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secreto-no-url') }),
    );
  });

  it('rechaza el LLM simulado en producción y lo permite en desarrollo', () => {
    expect(loadConfig({ ...valid, LLM_PROVIDER: 'simulado' }).LLM_PROVIDER).toBe('simulado');
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', LLM_PROVIDER: 'simulado' }),
    ).toThrow(/producción/);
  });

  it('cookie del panel: Secure por defecto y obligatoria en producción', () => {
    expect(loadConfig(valid).ADMIN_COOKIE_SECURE).toBe(true);
    expect(loadConfig({ ...valid, ADMIN_COOKIE_SECURE: 'false' }).ADMIN_COOKIE_SECURE).toBe(false);
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', ADMIN_COOKIE_SECURE: 'false' }),
    ).toThrow(/ADMIN_COOKIE_SECURE/);
  });

  it('capacidad por robot (v1.5): valores por defecto y respaldo de LLM opcional', () => {
    expect(loadConfig(valid)).toMatchObject({
      MAX_CHATS_PER_ROBOT: 3,
      RESPONSE_P95_ALERT_MS: 20_000,
      LLM_TIMEOUT_MS: 8_000,
      BROWSER_RECYCLE_HOURS: 6,
    });
    expect(
      loadConfig({ ...valid, LLM_FALLBACK_PROVIDER: '' }).LLM_FALLBACK_PROVIDER,
    ).toBeUndefined();
    expect(loadConfig({ ...valid, LLM_FALLBACK_PROVIDER: 'openai' }).LLM_FALLBACK_PROVIDER).toBe(
      'openai',
    );
    expect(() => loadConfig({ ...valid, LLM_FALLBACK_PROVIDER: 'otro' })).toThrow();
  });

  it('Gemini: proveedor principal o de respaldo; sus embeddings exigen GEMINI_API_KEY', () => {
    expect(loadConfig({ ...valid, LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })).toMatchObject({
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'k',
    });
    expect(loadConfig({ ...valid, LLM_FALLBACK_PROVIDER: 'gemini' }).LLM_FALLBACK_PROVIDER).toBe(
      'gemini',
    );
    expect(() => loadConfig({ ...valid, EMBEDDINGS_PROVIDER: 'gemini' })).toThrow(/GEMINI_API_KEY/);
    expect(
      loadConfig({ ...valid, EMBEDDINGS_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })
        .EMBEDDINGS_PROVIDER,
    ).toBe('gemini');
  });
});
