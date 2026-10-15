import type { LoginCredentials, LoginResult } from '../abaya/pages/login.page.js';
import type { StorageState } from './storage-state.store.js';

/** Lo que el SessionManager necesita del navegador. Permite probarlo sin Playwright. */
export interface SessionDriver {
  /** Crea un contexto nuevo (con o sin storageState) y navega a Abaya. */
  open(state?: StorageState): Promise<void>;
  isInboxVisible(): Promise<boolean>;
  login(creds: LoginCredentials): Promise<LoginResult>;
  exportState(): Promise<StorageState>;
  /**
   * «Salir» en ySocial (avatar → Salir → ACEPTAR). Cerrar el navegador NO cierra la sesión del
   * asesor: sin esto, el siguiente login responde «ya se encuentra conectado». true = salió.
   */
  logout(): Promise<boolean>;
  close(): Promise<void>;
}
