import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { LoginPage, type LoginCredentials } from '../abaya/pages/login.page.js';
import { sel } from '../abaya/selectors.js';
import type { SessionDriver } from './session-driver.js';
import type { StorageState } from './storage-state.store.js';

export interface PlaywrightSessionDriverOptions {
  baseUrl: string;
  headless: boolean;
  navigationTimeoutMs?: number;
}

/**
 * Driver real: un navegador por usuario robot, un contexto y una sola página activa
 * (sección 2.4). El contexto se recrea en cada `open` para descartar cookies vencidas.
 */
export class PlaywrightSessionDriver implements SessionDriver {
  private browser?: Browser;
  private context?: BrowserContext;
  private _page?: Page;
  private launchedAt?: number;

  constructor(private readonly opts: PlaywrightSessionDriverOptions) {}

  /** Milisegundos desde que se lanzó el proceso del navegador (0 si no está abierto). */
  get browserAgeMs(): number {
    return this.launchedAt ? Date.now() - this.launchedAt : 0;
  }

  /** Contexto actual del navegador (para las trazas). */
  get currentContext(): BrowserContext | undefined {
    return this.context;
  }

  /** Página activa, para el BrowserActor y el InboundWatcher. */
  get page(): Page {
    if (!this._page) throw new Error('Sesión sin página abierta');
    return this._page;
  }

  /** Se invoca cada vez que se crea una página nueva (para re-enganchar listeners). */
  onPage?: (page: Page) => Promise<void> | void;

  async open(state?: StorageState): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.opts.headless });
      this.launchedAt = Date.now();
    }
    await this.context?.close().catch(() => undefined);
    this.context = await this.browser.newContext({
      ...(state ? { storageState: state } : {}),
      locale: 'es-CO',
      timezoneId: 'America/Bogota',
    });
    const page = await this.context.newPage();
    page.setDefaultTimeout(this.opts.navigationTimeoutMs ?? 15_000);
    this._page = page;
    await this.onPage?.(page);
    await page.goto(this.opts.baseUrl, { waitUntil: 'domcontentloaded' });
    // Esperar a que se vea la bandeja o el login (lo que aparezca primero).
    await sel.session
      .inboxMarker(page)
      .or(sel.login.submit(page))
      .first()
      .waitFor({ state: 'visible' })
      .catch(() => undefined);
  }

  async isInboxVisible(): Promise<boolean> {
    if (!this._page || this._page.isClosed()) return false;
    return sel.session
      .inboxMarker(this._page)
      .isVisible()
      .catch(() => false);
  }

  async login(creds: LoginCredentials) {
    return new LoginPage(this.page).login(creds);
  }

  async exportState(): Promise<StorageState> {
    if (!this.context) throw new Error('Sesión sin contexto');
    return this.context.storageState();
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = undefined;
    this.browser = undefined;
    this._page = undefined;
    this.launchedAt = undefined;
  }
}
