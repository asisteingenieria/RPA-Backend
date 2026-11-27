import { describe, expect, it } from 'vitest';
import type { PrismaClient } from './generated/prisma/client.js';
import { PrismaUsageRecorder } from './usage.js';

/** Base falsa: cada escritura tarda un poco; la tercera falla. */
function fakePrisma() {
  const rows: unknown[] = [];
  let n = 0;
  const prisma = {
    modelUsage: {
      create: ({ data }: { data: unknown }) =>
        new Promise((resolve, reject) =>
          setTimeout(() => {
            n++;
            if (n === 3) reject(new Error('base caída'));
            else resolve(rows.push(data));
          }, 20),
        ),
    },
  } as unknown as PrismaClient;
  return { prisma, rows };
}

const usage = {
  kind: 'EVAL' as const,
  provider: 'gemini',
  model: 'gemini-3.8-flash',
  inputTokens: 9_000.4,
  outputTokens: -5,
  latencyMs: 1200,
};

describe('PrismaUsageRecorder', () => {
  it('flush espera todas las escrituras, aunque alguna falle', async () => {
    const { prisma, rows } = fakePrisma();
    const errors: unknown[] = [];
    const rec = new PrismaUsageRecorder(prisma, (e) => errors.push(e));
    for (let i = 0; i < 4; i++) rec.record(usage);
    expect(rows).toHaveLength(0);
    await rec.flush();
    expect(rows).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 9000, outputTokens: 0, kind: 'EVAL' });
  });

  it('flush sin escrituras pendientes termina de inmediato', async () => {
    const { prisma } = fakePrisma();
    await new PrismaUsageRecorder(prisma).flush();
  });
});
