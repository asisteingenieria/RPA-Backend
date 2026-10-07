import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type AuditEntry,
  type Me,
  type Overview,
  type PanelUser,
  type ReviewQueue,
  type Role,
  type TemporaryPassword,
} from './api.js';
import { message, time } from './format.js';
import { AgentView } from './Agent.js';
import { RobotsView } from './Robots.js';

const REFRESH_MS = 10_000;

const SESSION_TONE: Record<string, string> = {
  ACTIVE: 'ok',
  RELOGGING: 'warn',
  PAUSED: 'warn',
  DOWN: 'bad',
};

type View = 'operacion' | 'robots' | 'agente' | 'usuarios' | 'contrasena';

export function App() {
  // undefined = comprobando la sesión; null = sin sesión.
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  const logout = useCallback(() => {
    void api.logout().catch(() => undefined);
    setMe(null);
  }, []);
  const expired = useCallback(() => setMe(null), []);

  if (me === undefined) return <main className="login muted">Cargando…</main>;
  if (!me) return <Login onLogin={setMe} />;
  if (me.mustChangePassword) {
    return (
      <main className="login">
        <ChangePassword
          me={me}
          forced
          onDone={() => setMe({ ...me, mustChangePassword: false })}
          onCancel={logout}
        />
      </main>
    );
  }
  return <Dashboard me={me} onLogout={logout} onExpired={expired} />;
}

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onLogin(await api.login(username, password));
    } catch (err) {
      setPassword('');
      setError(message(err, 'No se pudo iniciar sesión.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h1>Agente RPA · Operación</h1>
        {error && <p className="notice">{error}</p>}
        <label>
          Usuario
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Entrar
        </button>
      </form>
    </main>
  );
}

function ChangePassword({
  me,
  forced,
  onDone,
  onCancel,
}: {
  me: Me;
  forced?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setError('Las contraseñas nuevas no coinciden.');
    setBusy(true);
    try {
      await api.changePassword(current, next);
      onDone();
    } catch (err) {
      setError(message(err, 'No se pudo cambiar la contraseña.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card narrow" onSubmit={(e) => void submit(e)}>
      <h1>Cambiar contraseña</h1>
      {forced && (
        <p className="muted">
          Hola, {me.username}. Tu contraseña es temporal: crea una propia para continuar.
        </p>
      )}
      {error && <p className="notice">{error}</p>}
      <label>
        {forced ? 'Contraseña temporal' : 'Contraseña actual'}
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label>
        Nueva contraseña (mínimo 12 caracteres; una frase funciona bien)
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </label>
      <label>
        Repite la nueva contraseña
        <input
          type="password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy}>
          Guardar
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          {forced ? 'Salir' : 'Cancelar'}
        </button>
      </div>
    </form>
  );
}

function Dashboard({
  me,
  onLogout,
  onExpired,
}: {
  me: Me;
  onLogout: () => void;
  onExpired: () => void;
}) {
  const isAdmin = me.role === 'ADMIN';
  const [view, setView] = useState<View>('operacion');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [review, setReview] = useState<ReviewQueue | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [o, r, a] = await Promise.all([
        api.overview(),
        api.review(),
        isAdmin ? api.audit() : Promise.resolve([]),
      ]);
      setOverview(o);
      setReview(r);
      setAudit(a);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onExpired();
      setError(
        err instanceof ApiError && err.status === 503
          ? 'Administración deshabilitada en el servidor.'
          : 'No se pudo actualizar.',
      );
    }
  }, [isAdmin, onExpired]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const toggleKill = async () => {
    if (!overview) return;
    setBusy(true);
    try {
      await api.setKillSwitch(!overview.killSwitch);
      setConfirmKill(false);
      await refresh();
    } catch (err) {
      setError(message(err, 'No se pudo cambiar el estado del robot.'));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (robotUser: string) => {
    setBusy(true);
    try {
      const r = await api.resetSession(robotUser);
      setError(r.note);
      await refresh();
    } catch (err) {
      setError(message(err, 'No se pudo habilitar el reintento.'));
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
              disabled={!overview || (ks && !isAdmin)}
              title={ks && !isAdmin ? 'Solo un ADMIN puede reanudar el robot' : undefined}
              onClick={() => setConfirmKill(true)}
            >
              {ks ? 'Reanudar robot' : 'Apagado de emergencia'}
            </button>
          )}
          <button className="ghost" onClick={onLogout}>
            Salir ({me.username} · {me.role})
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={view === 'operacion' ? '' : 'ghost'}
          onClick={() => setView('operacion')}
        >
          Operación
        </button>
        <button className={view === 'robots' ? '' : 'ghost'} onClick={() => setView('robots')}>
          Robots
        </button>
        <button className={view === 'agente' ? '' : 'ghost'} onClick={() => setView('agente')}>
          Agente
        </button>
        {isAdmin && (
          <button
            className={view === 'usuarios' ? '' : 'ghost'}
            onClick={() => setView('usuarios')}
          >
            Usuarios
          </button>
        )}
        <button
          className={view === 'contrasena' ? '' : 'ghost'}
          onClick={() => setView('contrasena')}
        >
          Cambiar contraseña
        </button>
      </nav>

      {error && <p className="notice">{error}</p>}

      {view === 'robots' && <RobotsView isAdmin={isAdmin} onExpired={onExpired} />}
      {view === 'agente' && <AgentView isAdmin={isAdmin} onExpired={onExpired} />}
      {view === 'usuarios' && isAdmin && <UsersAdmin me={me} onExpired={onExpired} />}
      {view === 'contrasena' && (
        <ChangePassword
          me={me}
          onDone={() => {
            setError('Contraseña actualizada. Se cerraron tus otras sesiones abiertas.');
            setView('operacion');
          }}
          onCancel={() => setView('operacion')}
        />
      )}

      {view === 'operacion' && (
        <>
          {overview && (
            <section className="grid">
              <Metric label="Conversaciones activas" value={overview.conversations.active} />
              <Metric label="En transferencia" value={overview.conversations.transferring} />
              <Metric label="Ventas hoy" value={overview.sales.today} />
              <Metric
                label="Transferidas al backoffice hoy"
                value={overview.sales.transferredToday}
              />
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
                        <span className={`pill ${SESSION_TONE[s.status] ?? 'warn'}`}>
                          {s.status}
                        </span>
                      </td>
                      <td>{time(s.lastHeartbeat)}</td>
                      <td>{time(s.lastLoginAt)}</td>
                      <td>{s.consecutiveFails}</td>
                      <td>
                        {s.status === 'DOWN' && isAdmin && (
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
            {isAdmin && (
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
            )}
          </div>
        </>
      )}
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

function UsersAdmin({ me, onExpired }: { me: Me; onExpired: () => void }) {
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('OPERADOR');
  const [issued, setIssued] = useState<TemporaryPassword | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers(await api.users());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onExpired();
      setError(message(err, 'No se pudo cargar la lista de usuarios.'));
    }
  }, [onExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<TemporaryPassword | PanelUser>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await action();
      if ('temporaryPassword' in r) setIssued(r);
      await load();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onExpired();
      setError(message(err, 'No se pudo completar la acción.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.createUser(username, role))) setUsername('');
  };

  const locked = (u: PanelUser) => !!u.lockedUntil && new Date(u.lockedUntil) > new Date();

  return (
    <>
      {issued && (
        <section className="card secret">
          <h2>Contraseña temporal de {issued.user.username}</h2>
          <p>
            <code>{issued.temporaryPassword}</code>
          </p>
          <p className="muted">
            Se muestra una sola vez: entrégala por un canal seguro. El usuario deberá cambiarla en
            su primer ingreso.
          </p>
          <button className="ghost small" onClick={() => setIssued(null)}>
            Ya la entregué, ocultar
          </button>
        </section>
      )}
      {error && <p className="notice">{error}</p>}

      <section className="card">
        <h2>Crear usuario</h2>
        <form className="inline" onSubmit={(e) => void create(e)}>
          <label>
            Usuario
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="nombre.apellido"
              autoComplete="off"
              required
            />
          </label>
          <label>
            Rol
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="OPERADOR">OPERADOR (consulta y apagado de emergencia)</option>
              <option value="ADMIN">ADMIN (todo, incluidos usuarios)</option>
            </select>
          </label>
          <button type="submit" disabled={busy}>
            Crear
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Usuarios del panel</h2>
        <table>
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Rol</th>
              <th>Estado</th>
              <th>Último ingreso</th>
              <th>Creado por</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.username === me.username;
              return (
                <tr key={u.id}>
                  <td>
                    {u.username}
                    {self && <span className="muted"> (tú)</span>}
                  </td>
                  <td>
                    <select
                      value={u.role}
                      disabled={busy || self}
                      onChange={(e) =>
                        void run(() => api.updateUser(u.id, { role: e.target.value as Role }))
                      }
                    >
                      <option value="ADMIN">ADMIN</option>
                      <option value="OPERADOR">OPERADOR</option>
                    </select>
                  </td>
                  <td>
                    {!u.active ? (
                      <span className="pill bad">Inactivo</span>
                    ) : locked(u) ? (
                      <span className="pill warn">Bloqueado</span>
                    ) : u.mustChangePassword ? (
                      <span className="pill warn">Contraseña temporal</span>
                    ) : (
                      <span className="pill ok">Activo</span>
                    )}
                  </td>
                  <td>{time(u.lastLoginAt)}</td>
                  <td>{u.createdBy ?? '—'}</td>
                  <td>
                    {!self && (
                      <div className="actions">
                        <button
                          className="small ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(() => api.updateUser(u.id, { active: !u.active }))
                          }
                        >
                          {u.active ? 'Desactivar' : 'Activar'}
                        </button>
                        <button
                          className="small ghost"
                          disabled={busy}
                          onClick={() => void run(() => api.resetPassword(u.id))}
                        >
                          Restablecer contraseña
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
