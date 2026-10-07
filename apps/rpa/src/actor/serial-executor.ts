/**
 * Prioridad de las acciones del robot (v1.5, sección 2.7): menor número = más urgente.
 * Enviar al cliente que espera va primero; cerrar chats, al final. Es seguro reordenar:
 * los envíos de un chat siempre salen antes que su transferencia o cierre.
 */
export const PRIORITY = {
  SEND: 0,
  OPEN_CHAT: 1,
  TRANSFER: 2,
  READ_INBOX: 3,
  CLOSE: 4,
  /** Reciclar el navegador: solo cuando no hay nada más en la fila. */
  MAINTENANCE: 5,
} as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

interface Pending {
  priority: number;
  seq: number;
  start: () => void;
}

/**
 * Ejecuta tareas de una en una (concurrencia 1 por sesión, sección 2.4). Entre las que
 * esperan, sale primero la de mayor prioridad y, a igual prioridad, la que llegó antes.
 * Un error en una tarea no bloquea las siguientes.
 */
export class SerialExecutor {
  private readonly queue: Pending[] = [];
  private running = false;
  private seq = 0;

  run<T>(task: () => Promise<T>, priority: number = PRIORITY.READ_INBOX): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        seq: this.seq++,
        start: () => {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              this.running = false;
              this.next();
            });
        },
      });
      this.next();
    });
  }

  private next() {
    if (this.running || !this.queue.length) return;
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i]!;
      const b = this.queue[best]!;
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    const [item] = this.queue.splice(best, 1);
    this.running = true;
    item!.start();
  }

  /** Tareas en curso + en espera. */
  get size(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }
}
