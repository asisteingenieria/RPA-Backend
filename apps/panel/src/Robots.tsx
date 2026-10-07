import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type EnrollmentCode,
  type Range,
  type RobotCredentials,
  type RobotDetail,
  type RobotList,
  type RobotListItem,
  type RobotStatus,
} from './api.js';
import { ago, message, ms, time } from './format.js';

const REFRESH_MS = 10_000;
/** Meta de la operación: 95 % de las respuestas en menos de 15 s (sección 2.7 del plan). */
const SLOW_MS = 15_000;

const STATUS: Record<RobotStatus, { label: string; tone: string; help: string }> = {
  EN_LINEA: { label: 'En línea', tone: 'ok', help: 'Trabajando y con sesión en Abaya.' },
  RECONECTANDO: { label: 'Reconectando', tone: 'warn', help: 'Volviendo a entrar a Abaya.' },
  CAIDO: {
    label: 'Caído (login)',
    tone: 'bad',
    help: 'Falló 3 logins seguidos y dejó de intentar. Revisar credenciales.',
  },
  SIN_SENAL: {
    label: 'Sin señal',
    tone: 'bad',
    help: 'El equipo no reporta hace más de 1 minuto: apagado sin aviso, sin red o colgado.',
  },
  APAGADO: { label: 'Apagado', tone: 'muted', help: 'Se apagó en orden o nunca arrancó.' },
  DESHABILITADO: { label: 'Deshabilitado', tone: 'muted', help: 'Instalación revocada.' },
};

const UPDATE_LABEL: Record<string, { label: string; tone: string }> = {
  PENDING: { label: 'Actualización pedida', tone: 'warn' },
  WAITING_IDLE: { label: 'Esperando a terminar sus chats', tone: 'warn' },
  DOWNLOADING: { label: 'Descargando', tone: 'warn' },
  STAGED: { label: 'Lista para activar', tone: 'warn' },
  APPLIED: { label: 'Actualizado', tone: 'ok' },
  FAILED: { label: 'Actualización fallida', tone: 'bad' },
  ROLLED_BACK: { label: 'Revertida (no arrancó)', tone: 'bad' },
};

const RANGE_LABEL: Record<Range, string> = {
  hoy: 'Hoy',
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
};

const ACTION_LABEL: Record<string, string> = {
  OPEN_CHAT: 'Abrir chat',
  SEND: 'Enviar mensaje',
  NOTE: 'Nota interna',
  TRANSFER: 'Transferir',
  CLOSE: 'Cerrar chat',
  LOGIN: 'Login',
};

const CONV_LABEL: Record<string, string> = {
  ACTIVE: 'Activas',
  WAITING_CONSENT: 'Esperando autorización',
  TRANSFERRING: 'Transfiriendo',
  TRANSFERRED_BACKOFFICE: 'Vendidas (backoffice)',
  CLOSED_NO_SALE: 'Sin venta',
  CLOSED_SUPPORT: 'Soporte',
  CLOSED_INACTIVE: 'Inactividad',
  NEEDS_REVIEW: 'En revisión',
};

function StatusPill({ r }: { r: { status: RobotStatus; paused: boolean } }) {
  const s = STATUS[r.status];
  return (
    <>
      <span className={`pill ${s.tone}`} title={s.help}>
        {s.label}
      </span>
      {r.paused && r.status !== 'DESHABILITADO' && (
        <span className="pill warn" title="No ejecuta acciones en Abaya hasta que se reanude.">
          Pausado
        </span>
      )}
    </>
  );
}

/** Pestaña "Robots" (v1.4): un robot por equipo, su estado y su rendimiento. */
export function RobotsView({ isAdmin, onExpired }: { isAdmin: boolean; onExpired: () => void }) {
  const [range, setRange] = useState<Range>('hoy');
  const [list, setList] = useState<RobotList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [install, setInstall] = useState<EnrollmentCode | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiError && err.status === 401) return onExpired();
      setError(message(err, fallback));
    },
    [onExpired],
  );

  const load = useCallback(async () => {
    try {
      setList(await api.robots(range));
    } catch (err) {
      fail(err, 'No se pudo cargar la lista de robots.');
    }
  }, [range, fail]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const run = async <T,>(action: () => Promise<T>, after?: (r: T) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await action();
      after?.(r);
      await load();
    } catch (err) {
      fail(err, 'No se pudo completar la acción.');
    } finally {
      setBusy(false);
    }
  };

  if (selected) {
    return (
      <RobotDetailView
        robotUser={selected}
        isAdmin={isAdmin}
        range={range}
        onRange={setRange}
        onBack={() => setSelected(null)}
        onError={fail}
      />
    );
  }

  const robots = list?.robots ?? [];
  const online = robots.filter((r) => r.status === 'EN_LINEA' || r.status === 'RECONECTANDO');
  const problems = robots.filter((r) => r.status === 'CAIDO' || r.status === 'SIN_SENAL');

  return (
    <>
      {install && <InstallCard code={install} onClose={() => setInstall(null)} />}
      {error && <p className="notice">{error}</p>}

      <section className="grid">
        <div className="card metric">
          <span className="value">{robots.length}</span>
          <span className="label">Robots registrados</span>
        </div>
        <div className="card metric">
          <span className="value">{online.length}</span>
          <span className="label">En línea ahora</span>
        </div>
        <div className={`card metric ${problems.length ? 'bad' : ''}`}>
          <span className="value">{problems.length}</span>
          <span className="label">Caídos o sin señal</span>
        </div>
        <div className="card metric">
          <span className="value">{robots.reduce((a, r) => a + r.openChats, 0)}</span>
          <span className="label">
            Chats abiertos (tope {list?.maxChatsPerRobot ?? 3} por robot)
          </span>
        </div>
        <div className="card metric">
          <span className="value">{robots.reduce((a, r) => a + r.metrics.sales, 0)}</span>
          <span className="label">Ventas ({RANGE_LABEL[range].toLowerCase()})</span>
        </div>
      </section>

      {isAdmin && adding && (
        <RobotForm
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={(robotUser, creds) =>
            void run(
              () => api.createRobot(robotUser, creds),
              (r) => {
                setInstall(r);
                setAdding(false);
              },
            )
          }
        />
      )}
      {isAdmin && editing && (
        <RobotForm
          robotUser={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={(robotUser, creds) =>
            void run(
              () => api.robotCredentials(robotUser, creds),
              (r) => {
                setError(r.note);
                setEditing(null);
              },
            )
          }
        />
      )}

      {list?.published && (
        <section className="card row">
          <div>
            <strong>Versión publicada:</strong> {list.published.version}{' '}
            {list.published.signatureValid ? (
              <span className="pill ok" title="Firma verificada con la clave pública de los robots">
                Firma válida
              </span>
            ) : (
              <span className="pill bad" title="No se ofrecerá a los robots">
                Firma inválida
              </span>
            )}
            <span className="muted"> · armada {time(list.published.builtAt)}</span>
          </div>
          {isAdmin && list.published.signatureValid && (
            <button
              disabled={busy}
              onClick={() =>
                void run(api.updateAll, (r) =>
                  setError(
                    `${r.robots} robot(s) se actualizarán a ${r.version} cuando terminen sus chats.`,
                  ),
                )
              }
            >
              Actualizar todos
            </button>
          )}
        </section>
      )}

      <section className="card">
        <div className="row">
          <h2>Robots por equipo</h2>
          <div className="actions">
            <RangePicker value={range} onChange={setRange} />
            <a className="button ghost" href="/admin/robots/package">
              Descargar instalador
            </a>
            {isAdmin && !adding && (
              <button onClick={() => setAdding(true)} disabled={busy}>
                Agregar robot
              </button>
            )}
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Robot</th>
              <th>Equipo</th>
              <th>Estado</th>
              <th>Última señal</th>
              <th>Versión</th>
              <th className="num" title="Chats en su bandeja / tope por robot">
                Chats
              </th>
              <th
                className="num"
                title="Desde que el cliente escribe hasta que Abaya confirma la respuesta (95 % de las respuestas)"
              >
                Respuesta p95
              </th>
              <th className="num">Conversaciones</th>
              <th className="num">Ventas</th>
              <th className="num">Conversión</th>
              <th className="num">Envío p95</th>
              <th className="num">Errores / inciertos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {robots.length ? (
              robots.map((r) => (
                <RobotRow
                  key={r.robotUser}
                  r={r}
                  published={list?.published?.signatureValid ? list.published.version : null}
                  onUpdate={() =>
                    void run<unknown>(() =>
                      r.update?.requested
                        ? api.cancelUpdate(r.robotUser)
                        : api.updateRobot(r.robotUser),
                    )
                  }
                  maxChats={list?.maxChatsPerRobot ?? 3}
                  isAdmin={isAdmin}
                  busy={busy}
                  onOpen={() => setSelected(r.robotUser)}
                  onPause={() => void run(() => api.pauseRobot(r.robotUser, !r.paused))}
                  onCode={() => void run(() => api.enrollmentCode(r.robotUser), setInstall)}
                  onCredentials={() => setEditing(r.robotUser)}
                  onEnable={() =>
                    void run(
                      () => api.enableRobot(r.robotUser, !r.enabled),
                      (x) => x.note && setError(x.note),
                    )
                  }
                />
              ))
            ) : (
              <tr>
                <td colSpan={13} className="muted">
                  {list ? 'No hay robots registrados.' : 'Cargando…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

function RobotRow({
  r,
  published,
  onUpdate,
  maxChats,
  isAdmin,
  busy,
  onOpen,
  onPause,
  onCode,
  onCredentials,
  onEnable,
}: {
  r: RobotListItem;
  published: string | null;
  onUpdate: () => void;
  maxChats: number;
  isAdmin: boolean;
  busy: boolean;
  onOpen: () => void;
  onPause: () => void;
  onCode: () => void;
  onCredentials: () => void;
  onEnable: () => void;
}) {
  const [confirmDisable, setConfirmDisable] = useState(false);
  const m = r.metrics;
  const duplicate =
    r.lastRejectedAt && Date.now() - new Date(r.lastRejectedAt).getTime() < 24 * 3_600_000;
  return (
    <>
      <tr>
        <td>
          <button className="link" onClick={onOpen}>
            {r.robotUser}
          </button>
        </td>
        <td>{r.host ?? <span className="muted">sin instalar</span>}</td>
        <td>
          <StatusPill r={r} />
        </td>
        <td>{ago(r.lastSeenAt)}</td>
        <td>
          {r.version ?? '—'}
          {r.update && UPDATE_LABEL[r.update.status] && (
            <div>
              <span
                className={`pill ${UPDATE_LABEL[r.update.status]!.tone}`}
                title={r.update.message ?? undefined}
              >
                {UPDATE_LABEL[r.update.status]!.label}
                {r.update.version && r.update.status !== 'APPLIED' ? ` ${r.update.version}` : ''}
              </span>
            </div>
          )}
        </td>
        <td className={`num ${r.openChats > maxChats ? 'bad-text' : ''}`}>
          {r.openChats} / {maxChats}
        </td>
        <td
          className={`num ${(m.responseP95Ms ?? 0) > SLOW_MS ? 'bad-text' : ''}`}
          title={m.responses ? `${m.responses} respuestas · p50 ${ms(m.responseP50Ms)}` : undefined}
        >
          {ms(m.responseP95Ms)}
        </td>
        <td className="num">{m.conversations}</td>
        <td className="num">{m.sales}</td>
        <td className="num">{m.conversionPct === null ? '—' : `${m.conversionPct} %`}</td>
        <td className="num">{ms(m.sendP95Ms)}</td>
        <td className={`num ${m.errors + m.uncertain ? 'bad-text' : ''}`}>
          {m.errors} / {m.uncertain}
        </td>
        <td>
          <div className="actions">
            <button className="small ghost" onClick={onOpen}>
              Ver
            </button>
            {isAdmin && r.enabled && (
              <>
                {(r.update?.requested || (published && r.version && r.version !== published)) && (
                  <button className="small ghost" disabled={busy} onClick={onUpdate}>
                    {r.update?.requested ? 'Cancelar actualización' : 'Actualizar'}
                  </button>
                )}
                <button className="small ghost" disabled={busy} onClick={onPause}>
                  {r.paused ? 'Reanudar' : 'Pausar'}
                </button>
                <button
                  className="small ghost"
                  disabled={busy || !r.hasCredentials}
                  onClick={onCode}
                >
                  {r.installed ? 'Reinstalar' : 'Código de instalación'}
                </button>
                <button className="small ghost" disabled={busy} onClick={onCredentials}>
                  Credenciales
                </button>
              </>
            )}
            {isAdmin &&
              (confirmDisable ? (
                <>
                  <button
                    className="small danger"
                    disabled={busy}
                    onClick={() => {
                      setConfirmDisable(false);
                      onEnable();
                    }}
                  >
                    Sí, deshabilitar
                  </button>
                  <button className="small ghost" onClick={() => setConfirmDisable(false)}>
                    No
                  </button>
                </>
              ) : (
                <button
                  className="small ghost"
                  disabled={busy}
                  onClick={() => (r.enabled ? setConfirmDisable(true) : onEnable())}
                >
                  {r.enabled ? 'Deshabilitar' : 'Habilitar'}
                </button>
              ))}
          </div>
        </td>
      </tr>
      {duplicate && (
        <tr className="warning-row">
          <td colSpan={13}>
            ⚠ Se intentó abrir este mismo robot en <strong>{r.lastRejectedHost}</strong> (
            {time(r.lastRejectedAt)}) mientras estaba en línea en {r.host ?? 'otro equipo'}. Se
            rechazó: un usuario de Abaya solo puede correr en un equipo a la vez.
          </td>
        </tr>
      )}
    </>
  );
}

function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Range)} aria-label="Rango">
      {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
        <option key={r} value={r}>
          {RANGE_LABEL[r]}
        </option>
      ))}
    </select>
  );
}

function RobotForm({
  robotUser,
  busy,
  onSubmit,
  onCancel,
}: {
  robotUser?: string;
  busy: boolean;
  onSubmit: (robotUser: string, creds: RobotCredentials) => void;
  onCancel: () => void;
}) {
  const editing = !!robotUser;
  const [user, setUser] = useState(robotUser ?? '');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState<'none' | 'totp'>('none');
  const [secret, setSecret] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const creds: RobotCredentials = {};
    if (password) creds.abayaPassword = password;
    if (!editing || mfa === 'totp' || secret) creds.mfaMode = mfa;
    if (mfa === 'totp') creds.totpSecret = secret;
    onSubmit(user.trim(), creds);
  };

  return (
    <section className="card">
      <h2>{editing ? `Credenciales de ${robotUser}` : 'Agregar robot'}</h2>
      <p className="muted">
        Las credenciales son las del usuario robot en Abaya. Se guardan cifradas en el servidor y
        nunca se vuelven a mostrar; cada equipo las recibe al arrancar.
      </p>
      <form className="inline" onSubmit={submit}>
        <label>
          Usuario de Abaya
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="robot-ventas-01"
            disabled={editing}
            autoComplete="off"
            required
          />
        </label>
        <label>
          {editing ? 'Nueva contraseña de Abaya (opcional)' : 'Contraseña de Abaya'}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required={!editing}
          />
        </label>
        <label>
          MFA
          <select value={mfa} onChange={(e) => setMfa(e.target.value as 'none' | 'totp')}>
            <option value="none">Sin MFA</option>
            <option value="totp">Código TOTP</option>
          </select>
        </label>
        {mfa === 'totp' && (
          <label>
            Secreto TOTP (base32)
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
        )}
        <button type="submit" disabled={busy}>
          {editing ? 'Guardar' : 'Crear y generar código'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancelar
        </button>
      </form>
    </section>
  );
}

function InstallCard({ code, onClose }: { code: EnrollmentCode; onClose: () => void }) {
  const server = window.location.origin;
  return (
    <section className="card secret">
      <h2>Instalar {code.robotUser} en un equipo</h2>
      <ol className="steps">
        <li>
          En el equipo del robot, descarga el instalador:{' '}
          <a href="/admin/robots/package">abaya-robot-windows.zip</a> y descomprímelo.
        </li>
        <li>
          Ejecuta <code>instalar.cmd</code>. Te pedirá:
          <ul>
            <li>
              Servidor: <code>{server}</code>
            </li>
            <li>
              Código de instalación: <code className="big">{code.enrollmentCode}</code>
            </li>
          </ul>
        </li>
        <li>El robot arranca solo y aparecerá aquí como “En línea” con el nombre del equipo.</li>
      </ol>
      <p className="muted">
        El código sirve una sola vez y vence {time(code.expiresAt)}. No contiene la contraseña de
        Abaya: el equipo la recibe del servidor cada vez que arranca.
      </p>
      <button className="ghost small" onClick={onClose}>
        Listo, ocultar
      </button>
    </section>
  );
}

function RobotDetailView({
  robotUser,
  isAdmin,
  range,
  onRange,
  onBack,
  onError,
}: {
  robotUser: string;
  isAdmin: boolean;
  range: Range;
  onRange: (r: Range) => void;
  onBack: () => void;
  onError: (err: unknown, fallback: string) => void;
}) {
  const [d, setD] = useState<RobotDetail | null>(null);
  const [traces, setTraces] = useState<{ ref: string; bytes: number; at: string }[]>([]);

  const load = useCallback(async () => {
    try {
      setD(await api.robot(robotUser, range));
      if (isAdmin) setTraces(await api.robotTraces(robotUser));
    } catch (err) {
      onError(err, 'No se pudo cargar el robot.');
    }
  }, [robotUser, range, isAdmin, onError]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const r = d?.robot;
  return (
    <>
      <div className="row">
        <button className="ghost" onClick={onBack}>
          ← Todos los robots
        </button>
        <RangePicker value={range} onChange={onRange} />
      </div>
      {!d || !r ? (
        <p className="muted">Cargando…</p>
      ) : (
        <>
          <section className="card">
            <div className="row">
              <h2>
                {r.robotUser} · {r.host ?? 'sin instalar'}
              </h2>
              <div>
                <StatusPill r={r} />
              </div>
            </div>
            <dl className="facts">
              <dt>Última señal</dt>
              <dd>{ago(r.lastSeenAt)}</dd>
              <dt>Encendido desde</dt>
              <dd>{r.status === 'APAGADO' ? '—' : time(r.startedAt)}</dd>
              <dt>Apagado</dt>
              <dd>{time(r.stoppedAt)}</dd>
              <dt>Versión</dt>
              <dd>{r.version ?? '—'}</dd>
              <dt>Instalado</dt>
              <dd>{r.installed ? time(r.enrolledAt) : 'No (modo .env o pendiente)'}</dd>
              <dt>Sesión en Abaya</dt>
              <dd>
                {d.session
                  ? `${d.session.status} · login ${time(d.session.lastLoginAt)} · ${d.session.consecutiveFails} fallos seguidos`
                  : '—'}
              </dd>
              <dt>MFA</dt>
              <dd>{r.mfaMode === 'totp' ? 'TOTP' : 'Sin MFA'}</dd>
            </dl>
          </section>

          <section className="grid">
            <div className={`card metric ${d.openChats > d.maxChatsPerRobot ? 'bad' : ''}`}>
              <span className="value">
                {d.openChats} / {d.maxChatsPerRobot}
              </span>
              <span className="label">Chats abiertos ahora</span>
            </div>
            <div className={`card metric ${(d.response.p95Ms ?? 0) > SLOW_MS ? 'bad' : ''}`}>
              <span className="value">{ms(d.response.p95Ms)}</span>
              <span className="label">
                Respuesta p95 · p50 {ms(d.response.p50Ms)} · {d.response.samples} respuestas
              </span>
            </div>
            <div className="card metric">
              <span className="value">{d.metrics.conversations}</span>
              <span className="label">Conversaciones</span>
            </div>
            <div className="card metric">
              <span className="value">{d.metrics.sales}</span>
              <span className="label">Ventas</span>
            </div>
            <div className="card metric">
              <span className="value">{d.metrics.transferred}</span>
              <span className="label">Transferidas al backoffice</span>
            </div>
            <div className="card metric">
              <span className="value">
                {d.metrics.conversionPct === null ? '—' : `${d.metrics.conversionPct} %`}
              </span>
              <span className="label">Conversión</span>
            </div>
          </section>

          <div className="two">
            <section className="card">
              <h2>Rendimiento por acción ({RANGE_LABEL[range].toLowerCase()})</h2>
              <table>
                <thead>
                  <tr>
                    <th>Acción</th>
                    <th className="num">Total</th>
                    <th className="num">OK</th>
                    <th className="num">Errores</th>
                    <th className="num">Inciertas</th>
                    <th className="num">Bloqueadas</th>
                    <th className="num">p50</th>
                    <th className="num">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {d.actions.length ? (
                    d.actions.map((a) => (
                      <tr key={a.action}>
                        <td>{ACTION_LABEL[a.action] ?? a.action}</td>
                        <td className="num">{a.total}</td>
                        <td className="num">{a.ok}</td>
                        <td className={`num ${a.errors ? 'bad-text' : ''}`}>{a.errors}</td>
                        <td className={`num ${a.uncertain ? 'bad-text' : ''}`}>{a.uncertain}</td>
                        <td className="num">{a.blocked}</td>
                        <td className="num">{ms(a.p50)}</td>
                        <td className="num">{ms(a.p95)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8} className="muted">
                        Sin acciones en el rango.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
            <section className="card">
              <h2>Conversaciones por resultado</h2>
              <table>
                <tbody>
                  {Object.entries(d.metrics.byStatus).length ? (
                    Object.entries(d.metrics.byStatus).map(([k, v]) => (
                      <tr key={k}>
                        <td>{CONV_LABEL[k] ?? k}</td>
                        <td className="num">{v}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="muted">Sin conversaciones en el rango.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </div>

          {isAdmin && (
            <section className="card">
              <h2>Trazas de error (últimos 7 días)</h2>
              <p className="muted">
                Grabación técnica de cada acción que falló o quedó incierta. Contiene pantallas de
                Abaya con datos de clientes: cada descarga queda en la auditoría. Se abre con{' '}
                <code>npx playwright show-trace archivo.zip</code>.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Referencia</th>
                    <th className="num">Tamaño</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {traces.length ? (
                    traces.map((t) => (
                      <tr key={t.ref}>
                        <td>{time(t.at)}</td>
                        <td>{t.ref}</td>
                        <td className="num">{Math.max(1, Math.round(t.bytes / 1024))} KB</td>
                        <td>
                          <a
                            href={`/admin/robots/${encodeURIComponent(robotUser)}/traces/${encodeURIComponent(t.ref)}`}
                          >
                            Descargar
                          </a>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="muted">
                        Sin trazas: no hubo acciones fallidas o inciertas.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          )}

          <section className="card">
            <h2>Historial de acciones (últimas 100)</h2>
            <table>
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Acción</th>
                  <th>Chat</th>
                  <th>Resultado</th>
                  <th className="num">Duración</th>
                </tr>
              </thead>
              <tbody>
                {d.recentActions.length ? (
                  d.recentActions.map((a, i) => (
                    <tr key={i}>
                      <td>{time(a.createdAt)}</td>
                      <td>{ACTION_LABEL[a.action] ?? a.action}</td>
                      <td>{a.abayaChatId ?? '—'}</td>
                      <td>
                        <span
                          className={`pill ${a.result === 'OK' ? 'ok' : a.result === 'BLOCKED' ? 'warn' : 'bad'}`}
                        >
                          {a.result}
                        </span>
                      </td>
                      <td className="num">{ms(a.durationMs)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="muted">
                      Sin acciones registradas.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}
