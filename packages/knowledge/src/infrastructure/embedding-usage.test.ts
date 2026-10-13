import type { ModelUsage } from '@abaya/domain';
import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../domain/ports.js';
import { withEmbeddingUsage } from './embeddings.js';

describe('consumo de embeddings', () => {
  it('registra tokens aproximados sin cambiar el resultado', async () => {
    const seen: ModelUsage[] = [];
    const base: EmbeddingProvider = {
      id: 'gemini',
      model: 'gemini-embedding-2',
      embed: async (texts) => texts.map(() => [1, 2]),
    };
    const p = withEmbeddingUsage(base, { record: (u) => seen.push(u) });
    expect(await p.embed(['abcdefgh', 'abcd'], 'document')).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(p.model).toBe('gemini-embedding-2');
    expect(seen).toMatchObject([
      {
        kind: 'EMBEDDING',
        provider: 'gemini',
        model: 'gemini-embedding-2',
        inputTokens: 3,
        estimated: true,
      },
    ]);
  });
});
