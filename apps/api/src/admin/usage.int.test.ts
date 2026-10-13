import { startTestDatabase, type TestDatabase } from '@abaya/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from './usage.service.js';

// Vista «Consumo» contra PostgreSQL real: suma LlmCall (conversaciones) y ModelUsage (otros usos).

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

describe('consumo de los modelos', () => {
  it('agrupa por uso, modelo y día, y estima el costo solo con tarifa', async () => {
    const now = new Date();
    const call = (conversationId: string, inputTokens: number, outputTokens: number) => ({
      conversationId,
      stage: 'PERFIL',
      provider: 'gemini',
      model: 'gemini-3.8-flash-001',
      promptVersionId: 'v1',
      latencyMs: 1000,
      inputTokens,
      outputTokens,
      validationResult: 'OK',
      createdAt: now,
    });
    await db.prisma.llmCall.createMany({
      data: [call('c1', 1_000, 100), call('c1', 2_000, 200), call('c2', 3_000, 300)],
    });
    await db.prisma.modelUsage.createMany({
      data: [
        {
          kind: 'VOICE',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          inputTokens: 500,
          outputTokens: 50,
          createdAt: now,
        },
        {
          kind: 'EMBEDDING',
          provider: 'gemini',
          model: 'gemini-embedding-2',
          inputTokens: 40,
          outputTokens: 0,
          estimated: true,
          createdAt: now,
        },
        // Fuera del rango de hoy: no cuenta.
        {
          kind: 'EVAL',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          inputTokens: 9_999,
          outputTokens: 9_999,
          createdAt: new Date(now.getTime() - 40 * 86_400_000),
        },
      ],
    });

    const s = await new UsageService(db.prisma, {
      'gemini-3.8-flash': { input: 1, output: 10 },
    }).summary({ range: '7d' });

    expect(s.totals).toMatchObject({
      calls: 5,
      inputTokens: 6_540,
      outputTokens: 650,
      costUsd: null,
      estimated: true,
    });
    const chat = s.byKind.find((k) => k.kind === 'CHAT')!;
    // Tarifa por prefijo: el proveedor respondió «gemini-3.8-flash-001».
    expect(chat).toMatchObject({ calls: 3, inputTokens: 6_000, outputTokens: 600 });
    expect(chat.costUsd).toBeCloseTo((6_000 * 1 + 600 * 10) / 1_000_000);
    expect(s.byKind.find((k) => k.kind === 'EMBEDDING')).toMatchObject({
      costUsd: null,
      estimated: true,
    });
    expect(s.byModel.find((m) => m.model === 'gemini-embedding-2')).toMatchObject({
      priced: false,
    });
    expect(s.conversations).toEqual({ count: 2, avgTokens: Math.round(6_600 / 2) });
    expect(s.sales).toEqual({ count: 0, avgTokens: null });
    expect(s.byDay.reduce((n, d) => n + d.tokens, 0)).toBe(6_540 + 650);
    expect(s.prices).toEqual({ configured: true, models: ['gemini-3.8-flash'] });

    await expect(new UsageService(db.prisma, {}).summary({ range: 'nunca' })).rejects.toMatchObject(
      { status: 400 },
    );
  });
});
