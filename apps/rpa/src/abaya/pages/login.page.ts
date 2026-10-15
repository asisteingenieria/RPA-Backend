import type { Page } from 'playwright';
import { sel } from '../selectors.js';

export interface LoginCredentials {
  username: string;
  password: string;
  /** Código TOTP si Abaya exige MFA. */
  otp?: string;
}

export type LoginResult =
  | 'OK'
  | 'INVALID_CREDENTIALS'
  | 'MFA_REQUIRED'
  /** El asesor ya tiene una sesión abierta en ySocial (otra ventana o un cierre sin «Salir»). */
  | 'ALREADY_CONNECTED'
  | 'TIMEOUT';

export class LoginPage {
  constructor(private readonly page: Page) {}

  async isVisible(): Promise<boolean> {
    return sel.login.submit(this.page).isVisible();
  }

  /** Campos del formulario de login que NO se ven (diagnóstico, D-020). Vacío = todo bien. */
  async missingFields(): Promise<string[]> {
    const fields = {
      usuario: sel.login.username(this.page),
      contraseña: sel.login.password(this.page),
      'botón Ingresar': sel.login.submit(this.page),
    };
    const missing: string[] = [];
    for (const [name, loc] of Object.entries(fields)) {
      if (!(await loc.isVisible().catch(() => false))) missing.push(name);
    }
    return missing;
  }

  async requiresOtp(): Promise<boolean> {
    return sel.login.otp(this.page).isVisible();
  }

  /**
   * @mutating Solo desde SessionManager / BrowserActor.
   * Las credenciales nunca se registran ni se incluyen en errores (regla 7).
   * Espera hasta 45 s: ySocial real muestra una barra de carga tras «Ingresar» (15/10/2026).
   */
  async login(creds: LoginCredentials, timeoutMs = 45_000): Promise<LoginResult> {
    const p = this.page;
    await sel.login.username(p).fill(creds.username);
    await sel.login.password(p).fill(creds.password);
    if (await this.requiresOtp()) {
      if (!creds.otp) return 'MFA_REQUIRED';
      await sel.login.otp(p).fill(creds.otp);
    }
    await sel.login.submit(p).click();

    const inbox = sel.session.inboxMarker(p);
    const error = sel.login.error(p);
    const already = sel.login.alreadyConnected(p);
    try {
      await inbox.or(error).or(already).first().waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      return 'TIMEOUT';
    }
    if (await inbox.isVisible()) return 'OK';
    if (await already.isVisible()) return 'ALREADY_CONNECTED';
    if (await this.requiresOtp()) return 'MFA_REQUIRED';
    return 'INVALID_CREDENTIALS';
  }
}
