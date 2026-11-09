import type { RobotActivity, RobotActivityKind } from '@abaya/robot-store';

export interface ActivityReporterDeps {
  send: (a: RobotActivity) => void;
  /** Acciones en curso + en espera en la fila del BrowserActor. */
  queued: () => number;
  now?: () => Date;
  /** Como máximo un envío cada tanto: las acciones cortas seguidas se resumen en la última. */
  throttleMs?: number;
  /** Se reenvía aunque no cambie (la actividad vence a los 60 s en el servidor). */
  heartbeatMs?: number;
}

/**
 * Monitor en vivo (D-032): informa al servidor qué hace el robot. Nunca frena una acción: si el
 * envío falla, la siguiente actualización o el latido lo repone.
 */
export class ActivityReporter {
  private current: RobotActivity;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private lastSent = 0;
  private idleSince?: string;
  private readonly now: () => Date;

  constructor(private readonly d: ActivityReporterDeps) {
    this.now = d.now ?? (() => new Date());
    this.current = {
      action: 'IDLE',
      abayaChatId: null,
      since: this.now().toISOString(),
      queued: 0,
    };
    this.idleSince = this.current.since;
  }

  start() {
    this.flush();
    this.heartbeat = setInterval(() => this.flush(), this.d.heartbeatMs ?? 20_000);
  }

  update(action: RobotActivityKind, abayaChatId: string | null) {
    if (this.current.action === action && this.current.abayaChatId === abayaChatId) return;
    // Revisar la bandeja (cada 15 s) no cuenta como trabajo: al volver a IDLE, sigue «libre desde» antes.
    const since =
      action === 'IDLE' && this.current.action === 'READ_INBOX' && this.idleSince
        ? this.idleSince
        : this.now().toISOString();
    if (action === 'IDLE') this.idleSince = since;
    else if (action !== 'READ_INBOX') this.idleSince = undefined;
    this.current = { action, abayaChatId, since, queued: 0 };
    if (this.timer) return;
    const wait = Math.max(0, this.lastSent + (this.d.throttleMs ?? 250) - this.now().getTime());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.timer = undefined;
  }

  private flush() {
    this.lastSent = this.now().getTime();
    try {
      this.d.send({ ...this.current, queued: Math.min(10_000, Math.max(0, this.d.queued())) });
    } catch {
      // Sin conexión: el latido lo vuelve a intentar.
    }
  }
}
