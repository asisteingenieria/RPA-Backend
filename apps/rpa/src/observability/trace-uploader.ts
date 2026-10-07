import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FieldCipher } from '@abaya/crypto';
import type { Logger } from '@abaya/logger';
import { traceAad } from '@abaya/robot-store';

/**
 * Robot hijo (v1.6): las trazas de error se graban en el equipo cifradas con su clave local y
 * se suben al servidor (que las guarda con la suya y las muestra en el panel). Confirmada la
 * subida, la copia local se borra; si el servidor no responde, se reintenta en la siguiente
 * vuelta (y la limpieza de 7 días aplica igual).
 */
export async function uploadPendingTraces(
  dir: string,
  localCipher: FieldCipher,
  upload: (ref: string, zip: Buffer) => Promise<void>,
  logger: Logger,
): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.trace.enc'));
  } catch {
    return 0;
  }
  let sent = 0;
  for (const f of files) {
    const ref = f.slice(0, -'.trace.enc'.length);
    try {
      const zip = localCipher.decrypt(await readFile(join(dir, f)), traceAad(ref));
      await upload(ref, zip);
      await rm(join(dir, f), { force: true });
      sent++;
    } catch (err) {
      logger.warn(
        { ref, err: err instanceof Error ? err.message : 'error' },
        'traza no subida; se reintentará',
      );
    }
  }
  return sent;
}
