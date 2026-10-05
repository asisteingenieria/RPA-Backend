import type { Page } from 'playwright';
import { sel } from '../selectors.js';

export interface LoginCredentials {
  username: string;
  password: string;
  /** Código TOTP si Abaya exige MFA. */
  otp?: string;
}

export type LoginResult = 'OK' | 'INVALID_CREDENTIALS' | 'MFA_REQUIRED' | 'TIMEOUT';

export class LoginPage {
  constructor(private readonly page: Page) {}

  async isVisible(): Promise<boolean> {
    return sel.login.submit(this.page).isVisible();
  }

  async requiresOtp(): Promise<boolean> {
    return sel.login.otp(this.page).isVisible();
  }

  /**
   * @mutating Solo desde SessionManager / BrowserActor.
   * Las credenciales nunca se registran ni se incluyen en errores (regla 7).
   */
  async login(creds: LoginCredentials, timeoutMs = 15_000): Promise<LoginResult> {
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
    try {
      await inbox.or(error).first().waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      return 'TIMEOUT';
    }
    if (await inbox.isVisible()) return 'OK';
    if (await this.requiresOtp()) return 'MFA_REQUIRED';
    return 'INVALID_CREDENTIALS';
  }
}
