/**
 * Códigos de salida del proceso rpa, que lee el lanzador del equipo robot (iniciar.cmd):
 * con NO_RESTART no se reintenta (deshabilitado, duplicado o instalación revocada); con
 * SHIFT (fin o espera del turno) se vuelve a arrancar enseguida (el 4 es EXIT_UPDATE).
 */
export const EXIT = { OK: 0, ERROR: 1, NO_RESTART: 3, SHIFT: 5 } as const;

/** El robot no debe trabajar en este equipo: reintentar no sirve. */
export class RobotRefusedError extends Error {
  readonly exitCode = EXIT.NO_RESTART;
}

let handler: ((exitCode: number) => void) | undefined;

/** main.ts registra el apagado ordenado (app.close) una vez arrancada la aplicación. */
export function onShutdownRequest(fn: (exitCode: number) => void) {
  handler = fn;
}

/** Pide el apagado ordenado del proceso (en Windows, process.kill no ejecuta los ganchos). */
export function requestShutdown(exitCode: number) {
  if (handler) handler(exitCode);
  else process.exit(exitCode);
}
