/**
 * Reintenta una transacción Serializable ante conflictos de concurrencia:
 * - P2034: conflicto de escritura / deadlock (la BD abortó la transacción).
 * - P2002 en `hash`: dos escrituras encadenaron al mismo prevHash (cadena de hashes).
 * La transacción completa se repite desde cero, así que es segura.
 */
export async function withSerializableRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (i + 1)));
    }
  }
  throw lastErr;
}

const SERIALIZATION = /40001|40P01|TransactionWriteConflict|could not serialize|deadlock/i;

export function isRetryable(err: unknown): boolean {
  const e = err as { code?: string; meta?: unknown };
  if (e?.code === 'P2034') return true;
  if (e?.code === 'P2002') return describe(e.meta).includes('hash');
  // El adaptador pg de Prisma 7 lanza DriverAdapterError con el código de PostgreSQL en la
  // propia excepción o en su causa.
  return SERIALIZATION.test(describe(err));
}

/** Texto con el mensaje, los campos propios y la causa (anidada) de un error. */
function describe(err: unknown, depth = 0): string {
  if (err === null || typeof err !== 'object' || depth > 3) return String(err ?? '');
  const own: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(err)) {
    if (k !== 'stack') own[k] = (err as Record<string, unknown>)[k];
  }
  let text = String(err);
  try {
    text += JSON.stringify(own);
  } catch {
    // estructuras circulares: basta con el mensaje
  }
  return text + describe((err as { cause?: unknown }).cause, depth + 1);
}
