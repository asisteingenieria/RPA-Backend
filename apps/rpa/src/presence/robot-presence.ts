import type { AlertPort } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import {
  PRESENCE_EVERY_MS,
  type BeatResult,
  type InstanceInfo,
  type PresenceStore,
} from '@abaya/robot-store';
import { RobotRefusedError } from '../lifecycle.js';

export {
  PRESENCE_EVERY_MS,
  PRESENCE_STALE_MS,
  PrismaPresenceStore,
  type BeatResult,
  type ClaimResult,
  type InstanceInfo,
  type PresenceStore,
} from '@abaya/robot-store';

export interface RobotPresenceDeps {
  store: PresenceStore;
  info: InstanceInfo;
  alerts: AlertPort;
  logger: Logger;
  /** Se llama si el panel deshabilita el robot u otra instancia lo toma: el proceso debe apagarse. */
  onEvicted: (reason: 'LOST' | 'DISABLED') => void;
  now?: () => Date;
  everyMs?: number;
}

/**
 * Un robot = un equipo a la vez. Reclama el robot antes de tocar Abaya, reporta presencia y lo
 * libera al apagarse en orden (así no dispara la alerta de heartbeat perdido).
 */
export class RobotPresence {
  private timer?: NodeJS.Timeout;
  private claimed = false;
  private readonly now: () => Date;

  constructor(private readonly d: RobotPresenceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** Lanza un error si no puede tomar el robot (deshabilitado o en línea en otro equipo). */
  async start(): Promise<void> {
    const { info } = this.d;
    const r = await this.d.store.claim(info, this.now());
    if (!r.ok) {
      if (r.reason === 'DUPLICATE') {
        await this.d.alerts.raise('ROBOT_DUPLICATE', 'CRITICA', {
          robotUser: info.robotUser,
          host: info.host,
          onlineHost: r.onlineHost,
        });
        throw new RobotRefusedError(
          `El robot ${info.robotUser} ya está en línea en ${r.onlineHost ?? 'otro equipo'}: ` +
            'este equipo no iniciará sesión en Abaya',
        );
      }
      throw new RobotRefusedError(`El robot ${info.robotUser} está deshabilitado en el panel`);
    }
    this.claimed = true;
    this.d.logger.info(
      { robotUser: info.robotUser, host: info.host, version: info.version },
      'robot registrado en el servidor',
    );
    this.timer = setInterval(() => void this.beat(), this.d.everyMs ?? PRESENCE_EVERY_MS);
  }

  async beat(): Promise<BeatResult> {
    const { info } = this.d;
    try {
      const r = await this.d.store.beat(info.robotUser, info.instanceId, this.now());
      if (r !== 'OK') {
        // Sigue "reclamado": al apagarse libera SOLO su instancia (si otro equipo tomó el
        // robot, la liberación no lo toca) y queda STOPPED en el panel.
        this.stopTimer();
        this.d.logger.error(
          { robotUser: info.robotUser, reason: r },
          'robot retirado por el servidor',
        );
        if (r === 'LOST') {
          await this.d.alerts.raise('ROBOT_DUPLICATE', 'CRITICA', {
            robotUser: info.robotUser,
            host: info.host,
          });
        }
        this.d.onEvicted(r);
      }
      return r;
    } catch (err) {
      // Sin base de datos: el heartbeat de la sesión y las alertas del servidor lo detectan.
      this.d.logger.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'no se pudo reportar presencia',
      );
      return 'OK';
    }
  }

  async stop(): Promise<void> {
    this.stopTimer();
    if (!this.claimed) return;
    this.claimed = false;
    await this.d.store.release(this.d.info.robotUser, this.d.info.instanceId, this.now());
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
