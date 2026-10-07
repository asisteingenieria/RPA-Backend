import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from '@abaya/logger';
import {
  GATEWAY_PATH,
  WS_CLOSE_NOT_OWNER,
  WS_CLOSE_REVOKED,
  type JobKind,
  type RobotFrame,
  type RpcMethod,
  type RpcParams,
  type ServerFrame,
} from '@abaya/robot-store';
import { WebSocket } from 'ws';
import { RobotRefusedError } from '../lifecycle.js';
import type { AgentFile } from './agent-file.js';

/** Renovar el acceso este tiempo antes de que venza (el token dura 1 h). */
const RENEW_BEFORE_MS = 10 * 60_000;
const RENEW_RETRY_MS = 30_000;
const RPC_TIMEOUT_MS = 20_000;
const WS_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface RemoteRobotConfig {
  nodeEnv: string;
  abayaBaseUrl: string;
  robotUser: string;
  password: string;
  mfaMode: 'none' | 'totp';
  totpSecret?: string;
  heartbeatMs: number;
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

/** Solo HTTPS, salvo el propio equipo (pruebas y demo) o si se permite explícitamente. */
export function assertSecureServer(server: string, allowHttp = false): URL {
  const url = new URL(server);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || allowHttp))) {
    throw new Error('El servidor debe usar HTTPS');
  }
  return url;
}

export const gatewayUrl = (server: string, path: string) =>
  new URL(`${GATEWAY_PATH}/${path}`, server.replace(/\/?$/, '/'));

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  return typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
}

/** Instalación: cambia el código de un solo uso por el token de renovación del equipo. */
export async function enrollWithCode(
  opts: { server: string; code: string; host: string; allowHttp?: boolean },
  fetchImpl: Fetch = fetch,
): Promise<{ robotUser: string; refreshToken: string }> {
  assertSecureServer(opts.server, opts.allowHttp);
  const res = await fetchImpl(gatewayUrl(opts.server, 'enroll'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: opts.code.trim(), host: opts.host }),
  });
  if (!res.ok) throw new Error(`No se pudo registrar el equipo: ${await errorText(res)}`);
  const body = (await res.json()) as { robotUser: string; token: string };
  return { robotUser: body.robotUser, refreshToken: body.token };
}

export interface JobHandler {
  (kind: JobKind, data: unknown, retries?: number): Promise<unknown>;
}

/**
 * Cliente de la pasarela del robot hijo (v1.6, sección 2.8): token de acceso renovado en
 * segundo plano, operaciones por HTTPS y tareas empujadas por WebSocket. Sin conexión al
 * servidor, el robot se considera detenido (`acting = false`): falla cerrado.
 */
export class GatewayClient {
  private access?: { token: string; expiresAt: number };
  private renewTimer?: NodeJS.Timeout;
  private ws?: WebSocket;
  private wsAttempt = 0;
  private wsTimer?: NodeJS.Timeout;
  private stopped = false;
  private flags = { killSwitch: true, paused: false };
  private connected = false;
  /** Se llama si el servidor revoca el robot o lo da a otra instancia: hay que apagarse. */
  onRefused?: (reason: string) => void;
  /** v1.7: el servidor pide instalar esta versión (o null si ya no). */
  onUpdate?: (version: string | null) => void;

  constructor(
    private readonly agent: AgentFile,
    private readonly logger: Logger,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    assertSecureServer(agent.server, process.env.ROBOT_ALLOW_HTTP === '1');
  }

  get robotUser(): string {
    return this.agent.robotUser;
  }

  /** ¿Puede actuar en Abaya? Conectado y sin kill switch ni pausa. */
  get acting(): boolean {
    return this.connected && !this.flags.killSwitch && !this.flags.paused;
  }

  /** Primer acceso (al arrancar): si el servidor rechaza el equipo, no tiene sentido reintentar. */
  async start(): Promise<void> {
    await this.renew(true);
  }

  async config(): Promise<RemoteRobotConfig> {
    return (await this.request('GET', 'config')) as RemoteRobotConfig;
  }

  async rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<unknown> {
    const body = (await this.request('POST', 'rpc', { method, params })) as { result: unknown };
    return body.result;
  }

  /** Manifiesto firmado de la versión publicada (el robot verifica la firma). */
  async releaseManifest(): Promise<unknown> {
    return this.request('GET', 'release');
  }

  /** Descarga el paquete publicado a un archivo (sin cargarlo entero en memoria). */
  async downloadRelease(path: string): Promise<void> {
    if (!this.access || this.access.expiresAt - Date.now() < 60_000) await this.renew(false);
    if (!this.access) throw new GatewayError(401, 'sin acceso a la pasarela');
    const res = await this.fetchImpl(gatewayUrl(this.agent.server, 'release/package'), {
      headers: { authorization: `Bearer ${this.access.token}` },
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!res.ok || !res.body) throw new GatewayError(res.status, await errorText(res));
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
  }

  async uploadTrace(ref: string, zip: Buffer): Promise<void> {
    await this.request('POST', `traces/${encodeURIComponent(ref)}`, zip);
  }

  /** Conecta el WebSocket (con la instancia que reclamó el robot) y reconecta si se corta. */
  connect(instanceId: string, onJob: JobHandler) {
    this.stopped = false;
    const open = () => {
      if (this.stopped || !this.access) return;
      const url = gatewayUrl(this.agent.server, `ws?instanceId=${instanceId}`);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.access.token}` } });
      this.ws = ws;
      ws.on('open', () => {
        this.connected = true;
        this.wsAttempt = 0;
        this.logger.info({ robotUser: this.robotUser }, 'conectado a la pasarela');
      });
      ws.on('message', (raw) => void this.onFrame(ws, String(raw), onJob));
      ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 409) this.refuse('otra instancia tiene este robot');
        ws.terminate();
      });
      ws.on('error', () => undefined);
      ws.on('close', (code) => {
        this.connected = false;
        if (code === WS_CLOSE_REVOKED) return this.refuse('robot deshabilitado o revocado');
        if (code === WS_CLOSE_NOT_OWNER) return this.refuse('otra instancia tomó el robot');
        if (this.stopped) return;
        const wait = WS_BACKOFF_MS[Math.min(this.wsAttempt++, WS_BACKOFF_MS.length - 1)]!;
        this.logger.warn({ robotUser: this.robotUser, waitMs: wait }, 'pasarela desconectada');
        this.wsTimer = setTimeout(open, wait);
      });
    };
    open();
  }

  async close() {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.renewTimer);
    clearTimeout(this.wsTimer);
    this.ws?.close(1000, 'apagado');
  }

  // ---------- internos ----------

  private async onFrame(ws: WebSocket, raw: string, onJob: JobHandler) {
    let f: ServerFrame;
    try {
      f = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    if (f.t === 'flags') {
      this.flags = { killSwitch: f.killSwitch, paused: f.paused };
      this.onUpdate?.(f.update ?? null);
      return;
    }
    if (f.t !== 'job') return;
    let reply: RobotFrame;
    try {
      reply = { t: 'result', id: f.id, ok: true, value: await onJob(f.kind, f.data, f.retries) };
    } catch (err) {
      reply = {
        t: 'result',
        id: f.id,
        ok: false,
        error: err instanceof Error ? err.message : 'error',
      };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  }

  private refuse(reason: string) {
    this.stopped = true;
    this.logger.error({ robotUser: this.robotUser, reason }, 'el servidor rechazó este equipo');
    this.onRefused?.(reason);
  }

  /** Renueva el acceso; reprograma la siguiente renovación. */
  private async renew(first = false): Promise<void> {
    clearTimeout(this.renewTimer);
    try {
      const res = await this.fetchImpl(gatewayUrl(this.agent.server, 'token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: await this.agent.refreshToken() }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        const msg = await errorText(res);
        if (first) {
          throw new RobotRefusedError(
            `El servidor rechazó este equipo (${msg}). Genere un código nuevo en el panel y reinstale.`,
          );
        }
        this.refuse(msg);
        return;
      }
      if (!res.ok) throw new GatewayError(res.status, await errorText(res));
      const body = (await res.json()) as {
        accessToken: string;
        expiresAt: string;
        refreshToken: string;
      };
      // Primero se guarda el token rotado; después se usa el acceso nuevo.
      await this.agent.setRefreshToken(body.refreshToken);
      this.access = { token: body.accessToken, expiresAt: Date.parse(body.expiresAt) };
      // Renovar cuando quede un tercio de la vida del token (como máximo 10 min antes):
      // con 1 h, a los 50 min. La conexión y las tareas en curso no se interrumpen.
      const remaining = this.access.expiresAt - Date.now();
      const next = Math.max(5_000, remaining - Math.min(RENEW_BEFORE_MS, remaining / 3));
      this.renewTimer = setTimeout(() => void this.renew(), next);
    } catch (err) {
      if (first || err instanceof RobotRefusedError) throw err;
      // Servidor no disponible: se reintenta; mientras tanto el acceso actual sigue valiendo.
      this.logger.warn(
        { err: err instanceof Error ? err.message : 'error' },
        'no se pudo renovar el acceso; se reintenta',
      );
      this.renewTimer = setTimeout(() => void this.renew(), RENEW_RETRY_MS);
    }
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      if (!this.access || this.access.expiresAt - Date.now() < 5_000) await this.renew(false);
      if (!this.access) throw new GatewayError(401, 'sin acceso a la pasarela');
      const isBinary = Buffer.isBuffer(body);
      const res = await this.fetchImpl(gatewayUrl(this.agent.server, path), {
        method,
        headers: {
          authorization: `Bearer ${this.access.token}`,
          ...(body === undefined
            ? {}
            : { 'content-type': isBinary ? 'application/octet-stream' : 'application/json' }),
        },
        ...(body === undefined
          ? {}
          : { body: isBinary ? new Uint8Array(body) : JSON.stringify(body) }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      // Acceso vencido o rotado del lado del servidor: renovar una vez y repetir.
      if (res.status === 401 && attempt === 0) {
        this.access = undefined;
        continue;
      }
      if (!res.ok) throw new GatewayError(res.status, await errorText(res));
      if (res.status === 204) return null;
      return res.json();
    }
  }
}
