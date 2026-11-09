import { describe, expect, it } from 'vitest';
import { isSentiment, worseSentiment } from './sentiment.js';

describe('D-035: sentimiento (solo medición)', () => {
  it('guarda el peor de la conversación', () => {
    expect(worseSentiment(undefined, 'NEUTRO')).toBe('NEUTRO');
    expect(worseSentiment('NEUTRO', 'MOLESTO')).toBe('MOLESTO');
    expect(worseSentiment('MOLESTO', 'POSITIVO')).toBe('MOLESTO');
    expect(worseSentiment('POSITIVO', 'NEGATIVO')).toBe('NEGATIVO');
  });
  it('solo acepta la lista cerrada', () => {
    expect(isSentiment('MOLESTO')).toBe(true);
    expect(isSentiment('FELIZ')).toBe(false);
  });
});
