import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FieldCipher } from '@abaya/crypto';
import type { BrowserContext } from 'playwright';

/**
 * Trazas de Playwright SOLO en error (sección 8): cada acción del actor abre un "chunk";
 * si la acción falla o queda incierta se guarda cifrado; si sale bien se descarta.
 * Las trazas contienen la pantalla (datos personales): siempre cifradas, retención corta.
 */
export interface TraceRecorder {
  begin(): Promise<void>;
  /** Guarda el chunk en curso (una sola vez por acción) y devuelve su referencia. */
  capture(label: string): Promise<string | null>;
  /** Cierra el chunk en curso sin guardarlo (si no se capturó). */
  discard(): Promise<void>;
}

export class NoopTraceRecorder implements TraceRecorder {
  async begin() {}
  async capture() {
    return null;
  }
  async discard() {}
}

export const traceAad = (ref: string) => `trace:${ref}`;

export class PlaywrightTraceRecorder implements TraceRecorder {
  private tracedContext?: BrowserContext;
  private open = false;

  constructor(
    private readonly context: () => BrowserContext | undefined,
    private readonly dir: string,
    private readonly cipher: FieldCipher,
    /** La traza nunca frena una acción, pero sus fallas deben verse en los logs. */
    private readonly onError?: (stage: 'begin' | 'capture', err: unknown) => void,
  ) {}

  async begin() {
    const ctx = this.context();
    if (!ctx) return;
    try {
      if (this.tracedContext !== ctx) {
        // Contexto nuevo (relogin): iniciar el tracing en él. Si ya estaba iniciado (por
        // ejemplo, bajo el runner de pruebas), se reutiliza.
        await ctx.tracing.start({ screenshots: true, snapshots: true }).catch((e: unknown) => {
          if (!/already started/i.test(String(e))) throw e;
        });
        this.tracedContext = ctx;
      }
      await ctx.tracing.startChunk();
      this.open = true;
    } catch (e) {
      this.onError?.('begin', e);
      this.open = false; // la traza nunca debe impedir la acción
    }
  }

  async capture(label: string): Promise<string | null> {
    const ctx = this.tracedContext;
    if (!this.open || !ctx) return null;
    this.open = false;
    const ref = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^\w-]/g, '_')}-${randomUUID().slice(0, 8)}`;
    const tmp = join(tmpdir(), `${ref}.zip`);
    try {
      await ctx.tracing.stopChunk({ path: tmp });
      await mkdir(this.dir, { recursive: true });
      await writeFile(
        join(this.dir, `${ref}.trace.enc`),
        this.cipher.encrypt(await readFile(tmp), traceAad(ref)),
        {
          mode: 0o600,
        },
      );
      return ref;
    } catch (e) {
      this.onError?.('capture', e);
      return null;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async discard() {
    if (!this.open || !this.tracedContext) return;
    this.open = false;
    await this.tracedContext.tracing.stopChunk().catch(() => undefined);
  }
}

/** Descifra una traza para verla con `npx playwright show-trace` (acceso auditado, F8). */
export async function decryptTrace(dir: string, ref: string, cipher: FieldCipher, outPath: string) {
  const enc = await readFile(join(dir, `${ref}.trace.enc`));
  await writeFile(outPath, cipher.decrypt(enc, traceAad(ref)));
}

/** Borra trazas más antiguas que `maxAgeDays` (retención máxima 7 días, sección 8). */
export async function cleanupTraces(
  dir: string,
  maxAgeDays = 7,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  for (const f of files.filter((x) => x.endsWith('.trace.enc'))) {
    const p = join(dir, f);
    const s = await stat(p).catch(() => null);
    if (s && now - s.mtimeMs > maxAgeDays * 86_400_000) {
      await rm(p, { force: true });
      removed++;
    }
  }
  return removed;
}
