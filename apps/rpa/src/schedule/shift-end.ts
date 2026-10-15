import type { AlertPort } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import { sel } from '../abaya/selectors.js';

/** Lo que usa del BrowserActor (regla 4: el cambio de estado pasa por él, con KillSwitch). */
export interface ShiftEndActor {
  readAgentState(): Promise<{ current: string | null; options: string[] }>;
  switchAgentState(name: string): Promise<'OK' | 'NOT_CHANGED' | 'BLOCKED_KILL_SWITCH'>;
  readInboxChatIds(): Promise<string[]>;
}

export interface ShiftEndDeps {
  robotUser: string;
  actor: ShiftEndActor;
  alerts: AlertPort;
  logger: Logger;
  /** Cada cuánto revisa la bandeja mientras termina los chats. */
  everyMs?: number;
  /** Si a los N ms sigue con chats, alerta a supervisión (una vez) y sigue esperando. */
  alertAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Fin del turno (horario del robot, 15/10/2026), como un asesor al terminar: pasa a la pausa de
 * fin de turno (no recibe casos nuevos), sigue atendiendo los que tiene y, con la bandeja vacía,
 * devuelve el control para el apagado ordenado («Salir» en Abaya, que ySocial esconde mientras
 * hay casos asignados). Nunca deja chats sin atender por la hora.
 */
export class ShiftEnd {
  constructor(private readonly d: ShiftEndDeps) {}

  async run(): Promise<void> {
    const every = this.d.everyMs ?? 30_000;
    const alertAfter = this.d.alertAfterMs ?? 30 * 60_000;
    const sleep = this.d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.d.now ?? Date.now;
    const started = now();
    let paused = false;
    let alerted = false;
    this.d.logger.info({ robotUser: this.d.robotUser }, 'fin del turno: pausa y cierre de chats');
    for (;;) {
      if (!paused) paused = await this.pause();
      const chats = await this.d.actor.readInboxChatIds().catch(() => null);
      if (paused && chats?.length === 0) {
        this.d.logger.info({ robotUser: this.d.robotUser }, 'fin del turno: bandeja vacía');
        return;
      }
      if (!alerted && now() - started >= alertAfter) {
        alerted = true;
        await this.d.alerts
          .raise('SHIFT_END_PENDING', 'ALTA', {
            robotUser: this.d.robotUser,
            openChats: chats?.length ?? null,
            paused,
          })
          .catch(() => undefined);
      }
      await sleep(every);
    }
  }

  /** true si quedó en pausa (o pendiente de pausa porque aún tiene chats). */
  private async pause(): Promise<boolean> {
    const state = await this.d.actor.readAgentState().catch(() => null);
    if (!state) return false;
    const target = state.options.includes(sel.state.shiftEnd)
      ? sel.state.shiftEnd
      : sel.state.pauses.find((p) => state.options.includes(p));
    if (!target) return false;
    if (state.current === target || sel.state.pendingPause.test(state.current ?? '')) return true;
    const r = await this.d.actor.switchAgentState(target).catch(() => 'NOT_CHANGED' as const);
    if (r === 'OK') return true;
    const after = (await this.d.actor.readAgentState().catch(() => null))?.current ?? '';
    return after === target || sel.state.pendingPause.test(after);
  }
}
