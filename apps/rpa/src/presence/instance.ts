import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

/** Nombre del equipo: ROBOT_HOST o el nombre de la máquina (solo letras, números y . _ -). */
export function robotHost(configured?: string): string {
  return (configured || hostname()).replace(/[^\w.-]/g, '_').slice(0, 64) || 'desconocido';
}

/** Versión del paquete del robot (la del instalador). */
export function robotVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      version?: string;
    };
    return pkg.version ?? 'desconocida';
  } catch {
    return 'desconocida';
  }
}
