/**
 * Ejecuta tareas de una en una, en orden de llegada (concurrencia 1 por sesión, sección 2.4).
 * Un error en una tarea no bloquea las siguientes.
 */
export class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(task);
    this.tail = result
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
    return result;
  }

  get size(): number {
    return this.pending;
  }
}
