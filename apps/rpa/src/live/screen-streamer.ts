import type { Logger } from '@abaya/logger';
import { SCREEN_FRAME_MAX_B64, type ScreenFrame } from '@abaya/robot-store';
import type { Page } from 'playwright';

export interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: { deviceWidth: number; deviceHeight: number };
}

/** Lo que se usa de una sesión CDP de Playwright (en las pruebas se reemplaza). */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onFrame(handler: (ev: ScreencastFrameEvent) => void): void;
  detach(): Promise<void>;
}

async function playwrightCdp(page: Page): Promise<CdpLike> {
  const session = await page.context().newCDPSession(page);
  return {
    send: (method, params) => session.send(method as never, params as never),
    onFrame: (handler) => void session.on('Page.screencastFrame', handler),
    detach: () => session.detach(),
  };
}

export interface ScreenStreamerDeps {
  /** Página actual del navegador del robot (undefined si no hay ninguna abierta). */
  page: () => Page | undefined;
  emit: (f: ScreenFrame) => void;
  logger: Logger;
  openCdp?: (page: Page) => Promise<CdpLike>;
  now?: () => Date;
  maxFps?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Sin cambios en pantalla, una imagen cada tanto (muestra que sigue en vivo). */
  keyframeMs?: number;
  tickMs?: number;
}

const CAPTURE_TIMEOUT_MS = 3_000;

/**
 * Pantalla en vivo (D-032): el screencast de Chromium (`Page.startScreencast`) del navegador del
 * robot, SOLO mientras un ADMIN lo mira. Solo lee la pantalla: no hace clic ni escribe (regla 4),
 * no pasa por la fila del BrowserActor y las imágenes no se guardan en ninguna parte.
 */
export class ScreenStreamer {
  private watched = false;
  private cdp?: CdpLike;
  private streamPage?: Page;
  private starting = false;
  private capturing = false;
  private tick?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private pending?: { jpeg: string; width: number; height: number };
  private lastSent = 0;
  /** Última imagen recibida (enviada o por enviar): sin cambios en `keyframeMs`, se captura. */
  private lastOffer = 0;
  private readonly now: () => Date;

  constructor(private readonly d: ScreenStreamerDeps) {
    this.now = d.now ?? (() => new Date());
  }

  get streaming(): boolean {
    return !!this.cdp;
  }

  setWatched(on: boolean) {
    if (on === this.watched) return;
    this.watched = on;
    if (on) {
      this.d.logger.info('pantalla en vivo: un ADMIN está mirando');
      this.lastSent = 0;
      this.lastOffer = 0;
      void this.ensure();
      this.tick = setInterval(() => void this.onTick(), this.d.tickMs ?? 1_000);
    } else {
      this.d.logger.info('pantalla en vivo: nadie mira, se detiene');
      clearInterval(this.tick);
      this.tick = undefined;
      void this.stopStream();
    }
  }

  async stop() {
    this.watched = false;
    clearInterval(this.tick);
    this.tick = undefined;
    await this.stopStream();
  }

  private async onTick() {
    if (!this.watched) return;
    // Relogin o reciclaje: la página cambió y hay que volver a engancharse.
    if (this.cdp && this.currentPage() !== this.streamPage) await this.stopStream();
    if (!this.cdp) await this.ensure();
    if (this.cdp && this.now().getTime() - this.lastOffer >= (this.d.keyframeMs ?? 5_000)) {
      await this.capture();
    }
  }

  private currentPage(): Page | undefined {
    try {
      return this.d.page();
    } catch {
      return undefined;
    }
  }

  private async ensure() {
    if (this.cdp || this.starting || !this.watched) return;
    const page = this.currentPage();
    if (!page) return;
    this.starting = true;
    try {
      const cdp = await (this.d.openCdp ?? playwrightCdp)(page);
      cdp.onFrame((f) => {
        // Sin el ack, Chromium deja de mandar imágenes.
        void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
        if (this.cdp !== cdp) return;
        this.offer(f.data, f.metadata.deviceWidth, f.metadata.deviceHeight);
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.d.quality ?? 55,
        maxWidth: this.d.maxWidth ?? 1280,
        maxHeight: this.d.maxHeight ?? 800,
        everyNthFrame: 1,
      });
      if (!this.watched) {
        await cdp.detach().catch(() => undefined);
        return;
      }
      this.cdp = cdp;
      this.streamPage = page;
      // Primera imagen de una vez (el screencast solo manda cuando algo cambia).
      await this.capture();
    } catch (err) {
      this.d.logger.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'pantalla en vivo: no se pudo iniciar; se reintenta',
      );
    } finally {
      this.starting = false;
    }
  }

  private async stopStream() {
    const cdp = this.cdp;
    this.cdp = undefined;
    this.streamPage = undefined;
    this.pending = undefined;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }

  /** Imagen forzada (inicio y cada `keyframeMs` sin cambios). */
  private async capture() {
    const cdp = this.cdp;
    const page = this.streamPage;
    if (!cdp || !page || this.capturing) return;
    this.capturing = true;
    try {
      const shot = (await Promise.race([
        cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.d.quality ?? 55 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CAPTURE_TIMEOUT_MS)),
      ])) as { data: string };
      const size = page.viewportSize() ?? { width: 1280, height: 720 };
      if (this.cdp === cdp) this.offer(shot.data, size.width, size.height);
    } catch {
      // Página cerrándose o ventana sin pintar: el siguiente intento lo repone.
    } finally {
      this.capturing = false;
    }
  }

  /** Como máximo `maxFps` por segundo; si llegan más, sale la última al abrirse el turno. */
  private offer(jpeg: string, width: number, height: number) {
    if (jpeg.length > SCREEN_FRAME_MAX_B64) return;
    this.lastOffer = this.now().getTime();
    this.pending = {
      jpeg,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
    if (this.flushTimer) return;
    const minGap = 1_000 / (this.d.maxFps ?? 2);
    const wait = Math.max(0, this.lastSent + minGap - this.now().getTime());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const p = this.pending;
      this.pending = undefined;
      if (!p || !this.watched) return;
      this.lastSent = this.now().getTime();
      try {
        this.d.emit({ ...p, at: this.now().toISOString() });
      } catch {
        // Sin conexión: se pierde esta imagen, no la acción del robot.
      }
    }, wait);
  }
}
