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
});
