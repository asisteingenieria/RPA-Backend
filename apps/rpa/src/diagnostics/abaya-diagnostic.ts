import type { Page } from 'playwright';
import { LoginPage, type LoginCredentials, type LoginResult } from '../abaya/pages/login.page.js';
import { sel } from '../abaya/selectors.js';
import type { ActionLog } from '../audit/action-log.js';
import type { KillSwitch } from '../safety/kill-switch.js';

/**
 * Diagnóstico de Abaya por pasos (D-020): prueba contra Abaya real lo que hace el robot, un
 * paso a la vez, con el mismo código (selectores, páginas, BrowserActor). Cada paso corre los
 * anteriores. Nunca abre ni escribe en un chat, ni guarda capturas o HTML (datos de clientes).
 */
export const STEPS = ['url', 'login', 'estado', 'disponible', 'bandeja'] as const;
export type Step = (typeof STEPS)[number];

export const STEP_HELP: Record<Step, string> = {
  url: 'abre Abaya y verifica que se vea el formulario de login',
  login: 'inicia sesión con el usuario robot (sin ponerse Disponible)',
  estado: 'lee el estado del asesor y las opciones del menú (solo lee)',
  disponible: 'pasa a «Disponible», lo confirma y vuelve enseguida a una pausa',
  bandeja: 'cuenta los casos asignados (solo lee, no abre ninguno)',
};

export interface StepResult {
  step: Step;
  ok: boolean;
  ms: number;
  detail: string;
}

/** Lo que el diagnóstico usa del driver de sesión (PlaywrightSessionDriver con goAvailable=false). */
export interface DiagnosticDriver {
  open(): Promise<void>;
  readonly page: Page;
  login(creds: LoginCredentials): Promise<LoginResult>;
  logout(): Promise<boolean>;
  close(): Promise<void>;
}

/** Lo que usa del BrowserActor (regla 4: los cambios de estado pasan por él). */
export interface DiagnosticActor {
  readAgentState(): Promise<{ current: string | null; options: string[] }>;
  switchAgentState(name: string): Promise<'OK' | 'NOT_CHANGED' | 'BLOCKED_KILL_SWITCH'>;
  readInboxChatIds(): Promise<string[]>;
}

export interface DiagnosticDeps {
  robotUser: string;
  driver: DiagnosticDriver;
  actor: DiagnosticActor;
  killSwitch: KillSwitch;
  actionLog: ActionLog;
  credentials: () => LoginCredentials;
  /** Avisa cada paso apenas termina (la consola lo imprime). */
  onStep?: (r: StepResult) => void;
  /** Al final, si entró: true si cerró la sesión en Abaya («Salir»), false si no pudo. */
  onLogout?: (ok: boolean) => void;
  /**
   * `--dejar-abierto`: no hace «Salir» ni cierra el navegador; la persona mira la ventana, sale
   * de Abaya a mano y la cierra (quien llama espera ese cierre).
   */
  keepOpen?: boolean;
}

export interface DiagnosticRun {
  results: StepResult[];
  /**
   * La ventana quedó abierta: con `keepOpen`, o porque no pudo hacer «Salir» (ySocial lo esconde
   * con casos asignados: p. ej. entraron casos en el paso «disponible»). Quien llama espera a que
   * la persona atienda los casos, salga de Abaya y cierre la ventana.
   */
  leftOpen: boolean;
}

const LOGIN_FAIL: Record<Exclude<LoginResult, 'OK'>, string> = {
  INVALID_CREDENTIALS: 'Abaya rechazó el usuario o la contraseña (revise el robot en el panel)',
  MFA_REQUIRED: 'Abaya pide doble factor y el robot no tiene ABAYA_TOTP_SECRET',
  ALREADY_CONNECTED:
    'Abaya dice que el agente ya está conectado: cierre esa sesión (avatar → Salir) o espere a que venza, y repita',
  TIMEOUT: 'no apareció la bandeja (avatar img.user-image) ni un mensaje de error',
};

export class AbayaDiagnostic {
  constructor(private readonly d: DiagnosticDeps) {}

  /** Corre los pasos hasta `target` (incluido) y se detiene en el primero que falle. */
  async run(target: Step): Promise<StepResult[]> {
    return (await this.runAndReport(target)).results;
  }

  async runAndReport(target: Step): Promise<DiagnosticRun> {
    const results: StepResult[] = [];
    let leftOpen = !!this.d.keepOpen;
    try {
      for (const step of STEPS.slice(0, STEPS.indexOf(target) + 1)) {
        const start = Date.now();
        let r: { ok: boolean; detail: string };
        try {
          r = await this.runStep(step);
        } catch (err) {
          r = { ok: false, detail: errorText(err) };
        }
        const result = { step, ok: r.ok, ms: Date.now() - start, detail: r.detail };
        results.push(result);
        this.d.onStep?.(result);
        if (!r.ok) break;
      }
    } finally {
      if (!leftOpen) {
        // Si entró, «Salir» antes de cerrar: si no, el siguiente login no entra (ya conectado).
        let out = true;
        if (results.some((r) => r.step === 'login' && r.ok)) {
          out = await this.d.driver.logout().catch(() => false);
          this.d.onLogout?.(out);
        }
        // Sin «Salir» (casos asignados) la ventana queda abierta: cerrarla dejaría a los clientes
        // asignados a una sesión que nadie ve (15/10/2026, paso «disponible» en ySocial real).
        if (out) await this.d.driver.close();
        else leftOpen = true;
      }
    }
    return { results, leftOpen };
  }

  private runStep(step: Step): Promise<{ ok: boolean; detail: string }> {
    switch (step) {
      case 'url':
        return this.url();
      case 'login':
        return this.login();
      case 'estado':
        return this.state();
      case 'disponible':
        return this.available();
      case 'bandeja':
        return this.inbox();
    }
  }

  private async url() {
    await this.d.driver.open();
    const page = this.d.driver.page;
    const missing = await new LoginPage(page).missingFields();
    const where = new URL(page.url()).pathname + new URL(page.url()).hash;
    return missing.length
      ? { ok: false, detail: `en ${where} no se ve: ${missing.join(', ')}` }
      : { ok: true, detail: `formulario de login visible en ${where}` };
  }

  /** Igual que el SessionManager: KillSwitch antes de actuar (regla 5) y LOGIN en la bitácora. */
  private async login() {
    const start = Date.now();
    if (await this.d.killSwitch.isActive()) {
      await this.logLogin('BLOCKED', start);
      return { ok: false, detail: 'bloqueado: kill switch o pausa del robot activos en el panel' };
    }
    const r = await this.d.driver.login(this.d.credentials());
    await this.logLogin(r === 'OK' ? 'OK' : 'ERROR', start);
    return r === 'OK'
      ? { ok: true, detail: `sesión iniciada como ${this.d.robotUser}` }
      : { ok: false, detail: `${r}: ${LOGIN_FAIL[r]}` };
  }

  private async state() {
    const { current, options } = await this.d.actor.readAgentState();
    if (!current) return { ok: false, detail: 'no se encontró el estado (nav span.title)' };
    if (!options.includes(sel.state.available)) {
      return {
        ok: false,
        detail: `estado «${current}», pero el menú no tiene «${sel.state.available}» (opciones: ${options.join(', ') || 'ninguna'})`,
      };
    }
    return { ok: true, detail: `estado «${current}» · menú: ${options.join(', ')}` };
  }

  /**
   * Ida y vuelta: «Disponible» hace que ySocial asigne casos reales, así que se vuelve enseguida
   * al estado anterior (o a una pausa). Si entra un caso en esos segundos, no se toca.
   */
  private async available() {
    const { current: before, options } = await this.d.actor.readAgentState();
    const back =
      before && options.includes(before)
        ? before
        : sel.state.pauses.find((p) => options.includes(p));
    if (!back) {
      return {
        ok: false,
        detail: `no se probó: no hay a qué estado volver (opciones: ${options.join(', ')})`,
      };
    }
    const casesBefore = new Set(await this.d.actor.readInboxChatIds().catch(() => []));
    const go = await this.d.actor.switchAgentState(sel.state.available);
    if (go === 'BLOCKED_KILL_SWITCH') {
      return { ok: false, detail: 'bloqueado: kill switch o pausa del robot activos en el panel' };
    }
    if (go !== 'OK') {
      const now = (await this.d.actor.readAgentState()).current;
      return { ok: false, detail: `no cambió a «${sel.state.available}» (sigue en «${now}»)` };
    }

    const returned = await this.d.actor.switchAgentState(back);
    const after = (await this.d.actor.readAgentState()).current ?? '';
    const cases = await this.d.actor.readInboxChatIds().catch(() => []);
    const arrived = cases.filter((id) => !casesBefore.has(id)).length;
    const caseNote = arrived
      ? ` · ATENCIÓN: entró ${arrived} caso(s) en esos segundos; no se tocó: atiéndalo en Abaya`
      : '';
    if (returned === 'OK') {
      return { ok: true, detail: `«${sel.state.available}» OK y de vuelta a «${back}»${caseNote}` };
    }
    if (sel.state.working.test(after)) {
      // Con un caso abierto ySocial deja la pausa pendiente («Trabajando (Pend. Aux.)»).
      return { ok: true, detail: `«${sel.state.available}» OK; quedó «${after}»${caseNote}` };
    }
    return {
      ok: false,
      detail: `pasó a «${sel.state.available}» pero NO volvió a «${back}» (está en «${after}»): cámbielo a mano YA${caseNote}`,
    };
  }

  private async inbox() {
    const ids = await this.d.actor.readInboxChatIds();
    return { ok: true, detail: `${ids.length} caso(s) asignado(s)` };
  }

  private async logLogin(result: 'OK' | 'ERROR' | 'BLOCKED', start: number) {
    await this.d.actionLog.append({
      robotUser: this.d.robotUser,
      action: 'LOGIN',
      abayaChatId: null,
      result,
      durationMs: Date.now() - start,
      traceRef: null,
      createdAt: new Date(),
    });
  }
}

/** Mensaje de error de una línea (los de Playwright traen el selector; sin datos de clientes). */
function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]!.slice(0, 300);
}
