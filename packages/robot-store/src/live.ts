import { robotActivityKey, screenChannel, screenLastKey, screenWatchKey } from '@abaya/domain';
import { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * Monitor en vivo (D-032): lo que hace cada robot en este momento y su pantalla, solo para mirar.
 * Nada de esto se guarda: la actividad vence a los 60 s y de la pantalla solo queda la última
 * imagen 10 s (para quien abre la vista sin esperar a que cambie).
 */

/** Lo que el `BrowserActor` está haciendo (IDLE = nada en la fila). */
export const ROBOT_ACTIVITIES = [
  'IDLE',
  'SEND',
  'OPEN_CHAT',
  'TRANSFER',
  'CLOSE',
  'READ_INBOX',
  'AGENT_STATE',
  'MAINTENANCE',
] as const;
export type RobotActivityKind = (typeof ROBOT_ACTIVITIES)[number];

export const robotActivitySchema = z.object({
  action: z.enum(ROBOT_ACTIVITIES),
  abayaChatId: z.string().min(1).max(200).nullable(),
  /** Desde cuándo hace esto (reloj del robot). */
  since: z.string().datetime(),
  /** Acciones en curso + en espera en la fila del actor. */
  queued: z.number().int().min(0).max(10_000),
});
export type RobotActivity = z.infer<typeof robotActivitySchema>;

/** Tope de una imagen en base64 (el WebSocket de la pasarela acepta 1 MB por mensaje). */
export const SCREEN_FRAME_MAX_B64 = 900_000;

export const screenFrameSchema = z.object({
  jpeg: z.string().min(1).max(SCREEN_FRAME_MAX_B64),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  at: z.string().datetime(),
});
export type ScreenFrame = z.infer<typeof screenFrameSchema>;

const ACTIVITY_TTL_S = 60;
export const SCREEN_WATCH_TTL_S = 10;
const SCREEN_LAST_TTL_S = 10;

/** Canal compartido entre el robot (o la pasarela) y la API del panel. */
export interface LiveBus {
  setActivity(robotUser: string, a: RobotActivity): Promise<void>;
  activities(robotUsers: string[]): Promise<Map<string, RobotActivity>>;
  /** Un ADMIN mira la pantalla: se marca por 10 s; quien mira lo renueva. */
  watchScreen(robotUser: string): Promise<void>;
  screenWatched(robotUser: string): Promise<boolean>;
  publishFrame(robotUser: string, f: ScreenFrame): Promise<void>;
  lastFrame(robotUser: string): Promise<ScreenFrame | null>;
  /** Devuelve la función para dejar de escuchar. */
  subscribeFrames(robotUser: string, cb: (f: ScreenFrame) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

function parse<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (!raw) return null;
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export class RedisLiveBus implements LiveBus {
  private readonly redis: Redis;
  private sub?: Redis;
  private readonly listeners = new Map<string, Set<(f: ScreenFrame) => void>>();

  constructor(private readonly url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
  }

  async setActivity(robotUser: string, a: RobotActivity) {
    await this.redis.set(robotActivityKey(robotUser), JSON.stringify(a), 'EX', ACTIVITY_TTL_S);
  }

  async activities(robotUsers: string[]) {
    const out = new Map<string, RobotActivity>();
    if (!robotUsers.length) return out;
    const raw = await this.redis.mget(...robotUsers.map(robotActivityKey));
    robotUsers.forEach((r, i) => {
      const a = parse(robotActivitySchema, raw[i] ?? null);
      if (a) out.set(r, a);
    });
    return out;
  }

  async watchScreen(robotUser: string) {
    await this.redis.set(screenWatchKey(robotUser), '1', 'EX', SCREEN_WATCH_TTL_S);
  }

  async screenWatched(robotUser: string) {
    return (await this.redis.exists(screenWatchKey(robotUser))) === 1;
  }

  async publishFrame(robotUser: string, f: ScreenFrame) {
    const raw = JSON.stringify(f);
    await this.redis
      .multi()
      .set(screenLastKey(robotUser), raw, 'EX', SCREEN_LAST_TTL_S)
      .publish(screenChannel(robotUser), raw)
      .exec();
  }

  async lastFrame(robotUser: string) {
    return parse(screenFrameSchema, await this.redis.get(screenLastKey(robotUser)));
  }

  async subscribeFrames(robotUser: string, cb: (f: ScreenFrame) => void) {
    const channel = screenChannel(robotUser);
    if (!this.sub) {
      // Una conexión en modo suscripción no puede hacer otras consultas: va aparte.
      this.sub = new Redis(this.url, { maxRetriesPerRequest: 1 });
      this.sub.on('message', (ch: string, raw: string) => {
        const set = this.listeners.get(ch);
        if (!set?.size) return;
        const f = parse(screenFrameSchema, raw);
        if (f) for (const l of set) l(f);
      });
    }
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(cb);
    return async () => {
      const s = this.listeners.get(channel);
      if (!s) return;
      s.delete(cb);
      if (!s.size) {
        this.listeners.delete(channel);
        await this.sub?.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async close() {
    this.listeners.clear();
    await this.sub?.quit().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
  }
}

/** Pruebas y desarrollo sin Redis (sin vencimientos: `unwatch` los simula). */
export class MemoryLiveBus implements LiveBus {
  readonly activity = new Map<string, RobotActivity>();
  readonly watched = new Set<string>();
  readonly last = new Map<string, ScreenFrame>();
  private readonly listeners = new Map<string, Set<(f: ScreenFrame) => void>>();

  async setActivity(robotUser: string, a: RobotActivity) {
    this.activity.set(robotUser, a);
  }
  async activities(robotUsers: string[]) {
    return new Map(
      robotUsers.flatMap((r) => {
        const a = this.activity.get(r);
        return a ? [[r, a] as const] : [];
      }),
    );
  }
  async watchScreen(robotUser: string) {
    this.watched.add(robotUser);
  }
  unwatch(robotUser: string) {
    this.watched.delete(robotUser);
  }
  async screenWatched(robotUser: string) {
    return this.watched.has(robotUser);
  }
  async publishFrame(robotUser: string, f: ScreenFrame) {
    this.last.set(robotUser, f);
    for (const l of this.listeners.get(robotUser) ?? []) l(f);
  }
  async lastFrame(robotUser: string) {
    return this.last.get(robotUser) ?? null;
  }
  async subscribeFrames(robotUser: string, cb: (f: ScreenFrame) => void) {
    let set = this.listeners.get(robotUser);
    if (!set) this.listeners.set(robotUser, (set = new Set()));
    set.add(cb);
    return async () => void set.delete(cb);
  }
  async close() {}
}
