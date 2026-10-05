import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type AuditEntry,
  type Credentials,
  type Overview,
  type ReviewQueue,
} from './api.js';

const REFRESH_MS = 10_000;
const STORAGE_KEY = 'abaya-panel-credentials';

function loadCredentials(): Credentials | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
}

const time = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(new Date(iso))
    : '—';

const SESSION_TONE: Record<string, string> = {
  ACTIVE: 'ok',
  RELOGGING: 'warn',
  PAUSED: 'warn',
  DOWN: 'bad',
};

export function App() {
  const [creds, setCreds] = useState<Credentials | null>(loadCredentials);
  if (!creds) {
    return (
      <Login
        onLogin={(c) => {
          try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
          } catch {
            // sin sessionStorage: la sesión dura lo que la pestaña
          }
          setCreds(c);
        }}
      />
    );
  }
  return (
    <Dashboard
      creds={creds}
      onLogout={() => {
        try {
          sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          // nada que limpiar
        }
        setCreds(null);
      }}
    />
  );
}

function Login({ onLogin }: { onLogin: (c: Credentials) => void }) {
  const [token, setToken] = useState('');
  const [user, setUser] = useState('');
  return (
    <main className="login">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (token && user) onLogin({ token, user });
        }}
      >
        <h1>Agente RPA · Operación</h1>
        <label>
          Tu usuario (queda en la auditoría)
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Token de administración
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit">Entrar</button>
      </form>
    </main>
  );
}

function Dashboard({ creds, onLogout }: { creds: Credentials; onLogout: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [review, setReview] = useState<ReviewQueue | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [o, r, a] = await Promise.all([
        api.overview(creds),
        api.review(creds),
        api.audit(creds),
      ]);
      setOverview(o);
      setReview(r);
      setAudit(a);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return onLogout();
      setError(
        err instanceof ApiError && err.status === 503
          ? 'Administración deshabilitada en el servidor.'
          : 'No se pudo actualizar.',
      );
    }
  }, [creds, onLogout]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const toggleKill = async () => {
    if (!overview) return;
    setBusy(true);
    try {
      await api.setKillSwitch(creds, !overview.killSwitch);
      setConfirmKill(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const reset = async (robotUser: string) => {
    setBusy(true);
    try {
      const r = await api.resetSession(creds, robotUser);
      setError(r.note);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const ks = overview?.killSwitch ?? false;
  return (
    <div className="app">
      <header className={ks ? 'topbar stopped' : 'topbar'}>
        <div>
          <strong>Agente RPA · Operación</strong>
          <span className="muted">
            {' '}
            · {overview ? `actualizado ${time(overview.generatedAt)}` : 'cargando…'}
          </span>
        </div>
        <div className="actions">
          <span className={ks ? 'pill bad' : 'pill ok'}>
            {ks ? 'ROBOT DETENIDO' : 'Robot operando'}
          </span>
          {confirmKill ? (
            <>
              <span>{ks ? '¿Reanudar el robot?' : '¿Detener TODAS las acciones del robot?'}</span>
              <button
                className={ks ? '' : 'danger'}
                disabled={busy}
                onClick={() => void toggleKill()}
              >
                Sí, {ks ? 'reanudar' : 'detener'}
              </button>
              <button className="ghost" onClick={() => setConfirmKill(false)}>
                Cancelar
              </button>
            </>
          ) : (
            <button
              className={ks ? '' : 'danger'}
              disabled={!overview}
              onClick={() => setConfirmKill(true)}
            >
              {ks ? 'Reanudar robot' : 'Apagado de emergencia'}
            </button>
          )}
          <button className="ghost" onClick={onLogout}>
            Salir ({creds.user})
          </button>
        </div>
      </header>

      {error && <p className="notice">{error}</p>}

      {overview && (
        <section className="grid">
          <Metric label="Conversaciones activas" value={overview.conversations.active} />
          <Metric label="En transferencia" value={overview.conversations.transferring} />
          <Metric label="Ventas hoy" value={overview.sales.today} />
          <Metric label="Transferidas al backoffice hoy" value={overview.sales.transferredToday} />
          <Metric
            label="Requieren revisión"
            value={overview.conversations.needsReview}
            tone={overview.conversations.needsReview ? 'bad' : 'ok'}
          />
        </section>
      )}

      <section className="card">
        <h2>Sesiones de los robots</h2>
        <table>
          <thead>
            <tr>
              <th>Robot</th>
              <th>Estado</th>
              <th>Último heartbeat</th>
              <th>Último login</th>
              <th>Fallos seguidos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {overview?.sessions.length ? (
              overview.sessions.map((s) => (
                <tr key={s.robotUser}>
                  <td>{s.robotUser}</td>
                  <td>
                    <span className={`pill ${SESSION_TONE[s.status] ?? 'warn'}`}>{s.status}</span>
                  </td>
                  <td>{time(s.lastHeartbeat)}</td>
                  <td>{time(s.lastLoginAt)}</td>
                  <td>{s.consecutiveFails}</td>
                  <td>
                    {s.status === 'DOWN' && (
                      <button
                        className="small"
                        disabled={busy}
                        onClick={() => void reset(s.robotUser)}
                      >
                        Habilitar reintento
                      </button>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="muted">
                  Sin sesiones registradas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Requieren revisión humana</h2>
        <table>
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Chat Abaya</th>
              <th>Robot</th>
              <th>Detalle</th>
              <th>Desde</th>
            </tr>
          </thead>
          <tbody>
            {review?.conversations.map((c) => (
              <tr key={c.id}>
                <td>Conversación</td>
                <td>{c.abayaChatId}</td>
                <td>{c.robotUser}</td>
                <td>estado {c.stage}</td>
                <td>{time(c.updatedAt)}</td>
              </tr>
            ))}
            {review?.uncertainMessages.map((m) => (
              <tr key={m.id}>
                <td>Envío incierto</td>
                <td>{m.conversation.abayaChatId}</td>
                <td>{m.conversation.robotUser}</td>
                <td>{m.attempts} intento(s): verificar en Abaya si llegó</td>
                <td>{time(m.createdAt)}</td>
              </tr>
            ))}
            {review && !review.conversations.length && !review.uncertainMessages.length && (
              <tr>
                <td colSpan={5} className="muted">
                  Nada pendiente.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="two">
        <section className="card">
          <h2>Errores recientes del robot</h2>
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                <th>Robot</th>
                <th>Acción</th>
                <th>Chat</th>
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {overview?.recentErrors.length ? (
                overview.recentErrors.map((e, i) => (
                  <tr key={i}>
                    <td>{time(e.createdAt)}</td>
                    <td>{e.robotUser}</td>
                    <td>{e.action}</td>
                    <td>{e.abayaChatId ?? '—'}</td>
                    <td>
                      <span className={`pill ${e.result === 'ERROR' ? 'bad' : 'warn'}`}>
                        {e.result}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="muted">
                    Sin errores recientes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>Auditoría del panel</h2>
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                <th>Usuario</th>
                <th>Acción</th>
                <th>Objetivo</th>
              </tr>
            </thead>
            <tbody>
              {audit.length ? (
                audit.map((a) => (
                  <tr key={a.id}>
                    <td>{time(a.createdAt)}</td>
                    <td>{a.actor}</td>
                    <td>{a.action}</td>
                    <td>{a.target ?? '—'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="muted">
                    Sin acciones registradas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'bad' }) {
  return (
    <div className={`card metric ${tone ?? ''}`}>
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  );
}
