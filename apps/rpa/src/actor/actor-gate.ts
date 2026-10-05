/**
 * Compuerta del BrowserActor: mientras está cerrada (sesión caída, relogin, kill switch)
 * ninguna acción de interfaz se ejecuta. El BrowserActor (F4) espera en `waitUntilOpen`.
 */
export class ActorGate {
  private readonly reasons = new Set<string>();
  private waiters: (() => void)[] = [];

  pause(reason: string): void {
    this.reasons.add(reason);
  }

  resume(reason: string): void {
    this.reasons.delete(reason);
    if (this.isOpen()) {
      const w = this.waiters;
      this.waiters = [];
      w.forEach((fn) => fn());
    }
  }

  isOpen(): boolean {
    return this.reasons.size === 0;
  }

  pausedBy(): string[] {
    return [...this.reasons];
  }

  waitUntilOpen(): Promise<void> {
    if (this.isOpen()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
