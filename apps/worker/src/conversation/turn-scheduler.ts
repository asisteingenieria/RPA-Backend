/**
 * Agrupador de ráfagas y serialización de turnos (sección 6.3.1):
 * 1. Espera `quietMs` (4 s) sin mensajes nuevos del cliente antes de procesar.
 * 2. Un turno a la vez por conversación; lo que llega mientras tanto se acumula para el
 *    siguiente turno.
 * 3. Conversaciones distintas se procesan en paralelo.
 *
 * Estado en memoria: válido con una sola instancia de worker. Para varias instancias, se
 * reemplaza por un trabajo diferido en BullMQ con jobId = conversationId y un candado.
 */
export class TurnScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private stopped = false;

  constructor(
    private readonly handler: (conversationId: string) => Promise<void>,
    private readonly opts: { quietMs?: number; onError?: (id: string, err: unknown) => void } = {},
  ) {}

  /** Llegó un mensaje del cliente a esta conversación. */
  notify(conversationId: string): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(conversationId));
    this.timers.set(
      conversationId,
      setTimeout(() => this.fire(conversationId), this.opts.quietMs ?? 4_000),
    );
  }

  private fire(id: string) {
    this.timers.delete(id);
    if (this.running.has(id)) {
      this.pending.add(id);
      return;
    }
    const run = (async () => {
      try {
        await this.handler(id);
      } catch (err) {
        this.opts.onError?.(id, err);
      } finally {
        this.running.delete(id);
        if (this.pending.delete(id) && !this.timers.has(id)) this.fire(id);
      }
    })();
    this.running.set(id, run);
  }

  /** Espera a que no queden turnos programados ni en curso. */
  async idle(): Promise<void> {
    while (this.timers.size || this.running.size) {
      await Promise.all([...this.running.values()]);
      if (this.timers.size) await new Promise((r) => setTimeout(r, 10));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.all([...this.running.values()]);
  }
}
