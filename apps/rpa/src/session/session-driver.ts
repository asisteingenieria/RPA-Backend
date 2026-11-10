import type { LoginCredentials, LoginResult } from '../abaya/pages/login.page.js';
import type { StorageState } from './storage-state.store.js';

/** Lo que el SessionManager necesita del navegador. Permite probarlo sin Playwright. */
export interface SessionDriver {
  /** Crea un contexto nuevo (con o sin storageState) y navega a Abaya. */
  open(state?: StorageState): Promise<void>;
  isInboxVisible(): Promise<boolean>;
  /**
   * D-039: qué muestra la página actual, sin navegar: la bandeja (sesión viva), el formulario de
   * login (Avaya cerró la sesión) o ninguna de las dos (cargando, recargando, sin página).
   */
  screen(): Promise<'INBOX' | 'LOGIN' | 'UNKNOWN'>;
  /** D-039: recarga la página en el MISMO contexto (como F5 de la asesora): no tira la sesión. */
  reload(): Promise<void>;
  login(creds: LoginCredentials): Promise<LoginResult>;
  exportState(): Promise<StorageState>;
  /**
   * «Salir» en ySocial (avatar → Salir → ACEPTAR). Cerrar el navegador NO cierra la sesión del
   * asesor: sin esto, el siguiente login responde «ya se encuentra conectado». true = salió.
   */
  logout(): Promise<boolean>;
  close(): Promise<void>;
}
