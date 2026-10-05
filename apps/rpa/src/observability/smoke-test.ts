import type { AlertPort } from '@abaya/domain';

export type SmokeResult = { ok: true; chats: number } | { ok: false; reason: string };

/**
 * Prueba de humo (sección 12, cada 15 min): sesión activa y bandeja legible. Solo lee:
 * nunca escribe en Abaya. Si falla, alerta ALTA.
 */
export async function runSmokeTest(d: {
  sessionStatus: () => string;
  readInbox: () => Promise<string[]>;
  alerts: AlertPort;
  robotUser: string;
  timeoutMs?: number;
}): Promise<SmokeResult> {
  let result: SmokeResult;
  const status = d.sessionStatus();
  if (status !== 'ACTIVE') {
    result = { ok: false, reason: `sesión en ${status}` };
  } else {
    try {
      const ids = await Promise.race([
        d.readInbox(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('timeout')), d.timeoutMs ?? 30_000),
        ),
      ]);
      result = { ok: true, chats: ids.length };
    } catch (err) {
      result = {
        ok: false,
        reason: `bandeja no legible: ${err instanceof Error ? err.message : 'error'}`,
      };
    }
  }
  if (!result.ok) {
    await d.alerts.raise('SMOKE_TEST_FAILED', 'ALTA', {
      robotUser: d.robotUser,
      reason: result.reason,
    });
  }
  return result;
}
