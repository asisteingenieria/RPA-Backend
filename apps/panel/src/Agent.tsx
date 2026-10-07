import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type AgentFields,
  type AgentIssue,
  type AgentOverview,
  type AgentStatus,
  type AgentVersionInfo,
  type EvalSummary,
} from './api.js';
import { message, time } from './format.js';
import { AgentTest } from './AgentTest.js';
import { Markdown } from './Markdown.js';

/**
 * Configuración del agente (v1.8, sección 6.3.8), con la distribución de Dapta: ajustes a la
 * izquierda y el guion completo en un bloque grande a la derecha. Precios y planes NO van en
 * el guion (regla 11): el catálogo se ve al lado y se nombra con {{OFERTA:CODIGO}}.
 */

const STATUS: Record<AgentStatus, { label: string; tone: string }> = {
  PUBLISHED: { label: 'Publicado', tone: 'ok' },
  DRAFT: { label: 'Borrador', tone: 'warn' },
  EVALUATING: { label: 'Evaluando…', tone: 'warn' },
  REJECTED: { label: 'Rechazado', tone: 'bad' },
  ARCHIVED: { label: 'Archivado', tone: 'muted' },
};

const FIELD_LABEL: Record<keyof AgentFields, string> = {
  agentName: 'Nombre del agente',
  companyName: 'Nombre de empresa',
  companyInfo: 'Descripción de la empresa',
  welcome: 'Mensaje de bienvenida',
  prompt: 'Guion',
  model: 'Modelo',
  temperature: 'Temperatura',
};

const PROCESS_LABEL: Record<string, string> = {
  PORTABILIDAD: 'Portabilidad',
  MIGRACION: 'Migración',
  LINEA_NUEVA: 'Línea nueva',
};

const cop = (v: number) =>
  '$' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(v);

function fieldsOf(v: AgentFields): AgentFields {
  return {
    agentName: v.agentName,
    companyName: v.companyName,
    companyInfo: v.companyInfo,
    welcome: v.welcome,
    prompt: v.prompt,
    model: v.model,
    temperature: v.temperature,
  };
}

const same = (a: AgentFields, b: AgentFields) => JSON.stringify(a) === JSON.stringify(b);

function StatusPill({ status }: { status: AgentStatus }) {
  const s = STATUS[status];
  return <span className={`pill ${s.tone}`}>{s.label}</span>;
}

function evalLine(s: EvalSummary | null | undefined): string {
  if (!s) return '—';
  if (s.cases === undefined) return s.problems?.[0] ?? '—';
  return `${s.passed}/${s.cases} correctos · ${s.invented} inventados`;
}

export function AgentView({ isAdmin, onExpired }: { isAdmin: boolean; onExpired: () => void }) {
  const [data, setData] = useState<AgentOverview | null>(null);
  const [form, setForm] = useState<AgentFields | null>(null);
  const [base, setBase] = useState<AgentFields | null>(null);
  const [issues, setIssues] = useState<AgentIssue[]>([]);
  const [mode, setMode] = useState<'markdown' | 'preview'>('markdown');
  const [versions, setVersions] = useState<AgentVersionInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [tab, setTab] = useState<'config' | 'probar'>('config');
  const editor = useRef<HTMLTextAreaElement>(null);

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiError && err.status === 401) return onExpired();
      setError(message(err, fallback));
    },
    [onExpired],
  );

  const load = useCallback(
    async (resetForm: boolean) => {
      try {
        const [o, v] = await Promise.all([api.agent(), api.agentVersions()]);
        setData(o);
        setVersions(v);
        const current = fieldsOf(o.working ?? o.published);
        setBase(current);
        if (resetForm) setForm(current);
      } catch (err) {
        fail(err, 'No se pudo cargar la configuración del agente.');
      }
    },
    [fail],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const working = data?.working ?? null;
  const evaluating = working?.status === 'EVALUATING';

  // Mientras evalúa, consultar cada 5 s hasta que el worker publique o rechace.
  useEffect(() => {
    if (!evaluating) return;
    const t = setInterval(() => void load(true), 5_000);
    return () => clearInterval(t);
  }, [evaluating, load]);

  // Revisión en vivo (sin guardar), con una pausa para no consultar en cada tecla.
  useEffect(() => {
    if (!form) return;
    const t = setTimeout(() => {
      api.reviewAgent(form).then(
        (r) => setIssues(r.issues),
        () => undefined,
      );
    }, 600);
    return () => clearTimeout(t);
  }, [form]);

  const dirty = !!form && !!base && !same(form, base);
  const status: AgentStatus = working?.status ?? 'PUBLISHED';
  const version = working?.version ?? data?.published.version;
  const readOnly = !isAdmin || evaluating;
  const tokens = useMemo(() => Math.ceil((form?.prompt.length ?? 0) / 4), [form?.prompt]);

  const set = <K extends keyof AgentFields>(k: K, v: AgentFields[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.saveAgentDraft(form);
      setNotice(`Borrador v${saved.version} guardado. Publícalo para que el robot lo use.`);
      await load(true);
    } catch (err) {
      if (err instanceof ApiError && err.issues) setIssues(err.issues);
      fail(err, 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.publishAgent();
      setNotice(
        `Evaluando v${r.version} con la suite completa. Si cumple la meta (0 datos inventados y ≥ 95 % correctos) se publica sola.`,
      );
      await load(true);
    } catch (err) {
      if (err instanceof ApiError && err.issues) setIssues(err.issues);
      fail(err, 'No se pudo publicar.');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (v: AgentVersionInfo) => {
    if (dirty && !window.confirm('Hay cambios sin guardar que se perderán. ¿Continuar?')) return;
    setBusy(true);
    setError(null);
    try {
      const d = await api.restoreAgentVersion(v.id);
      setNotice(`Contenido de v${v.version} copiado como borrador v${d.version}.`);
      await load(true);
    } catch (err) {
      fail(err, 'No se pudo restaurar.');
    } finally {
      setBusy(false);
    }
  };

  const discard = () => base && setForm(base);

  const goToLine = (line: number) => {
    const el = editor.current;
    if (!el || !form) return;
    setMode('markdown');
    const lines = form.prompt.split('\n');
    const start = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
      el.scrollTop = Math.max(0, (line - 4) * 20);
    });
  };

  const copyMarker = (code: string) => {
    const marker = `{{OFERTA:${code}}}`;
    navigator.clipboard?.writeText(marker).then(
      () => setNotice(`Copiado ${marker}`),
      () => setNotice(`Escribe ${marker} en el guion`),
    );
  };

  if (!data || !form) {
    return <p className="muted">{error ?? 'Cargando configuración del agente…'}</p>;
  }

  const issuesFor = (f: keyof AgentFields) => issues.filter((i) => i.field === f);
  const fieldError = (f: keyof AgentFields) =>
    issuesFor(f).length > 0 && (
      <span className="field-error">
        {issuesFor(f)
          .map((i) => i.message)
          .join(' · ')}
      </span>
    );
  const summary = working?.evalSummary;
  const canSave = isAdmin && !evaluating && !busy && dirty && issues.length === 0;
  const canPublishNow =
    isAdmin && data.canPublish && !busy && !dirty && working?.status === 'DRAFT' && !issues.length;

  return (
    <div className="agent">
      <div className="agent-head">
        <div className="agent-title">
          <h1>{form.agentName || 'Agente'}</h1>
          <StatusPill status={status} />
          {version !== undefined && <span className="muted">v{version}</span>}
          {dirty && <span className="pill warn">Cambios sin guardar</span>}
        </div>
        {isAdmin && (
          <div className="actions">
            {dirty && (
              <button className="ghost" onClick={discard} disabled={busy}>
                Descartar
              </button>
            )}
            <button className="ghost" onClick={() => void save()} disabled={!canSave}>
              Guardar
            </button>
            <button
              onClick={() => void publish()}
              disabled={!canPublishNow}
              title={
                !data.canPublish
                  ? (data.publishBlocker ?? undefined)
                  : dirty
                    ? 'Guarda los cambios antes de publicar'
                    : working?.status !== 'DRAFT'
                      ? 'No hay un borrador para publicar'
                      : undefined
              }
            >
              Publicar
            </button>
          </div>
        )}
      </div>

      <nav className="subtabs">
        <button className={tab === 'config' ? '' : 'ghost'} onClick={() => setTab('config')}>
          Configuración
        </button>
        <button className={tab === 'probar' ? '' : 'ghost'} onClick={() => setTab('probar')}>
          Probar agente
        </button>
      </nav>

      {tab === 'probar' ? (
        <AgentTest
          isAdmin={isAdmin}
          fields={form}
          provider={data.provider}
          onIssues={setIssues}
          onExpired={onExpired}
        />
      ) : (
        <>
          {!isAdmin && <p className="notice">Solo un ADMIN puede modificar el agente.</p>}
          {!data.canPublish && isAdmin && (
            <p className="notice">
              Puedes guardar borradores, pero todavía no publicar: {data.publishBlocker} Publicar
              corre la suite de evaluación completa (regla 13).
            </p>
          )}
          {error && <p className="notice bad-notice">{error}</p>}
          {notice && <p className="notice ok-notice">{notice}</p>}
          {evaluating && (
            <p className="notice">
              Evaluando v{working?.version}… la pantalla se actualiza sola. Mientras tanto no se
              puede editar.
            </p>
          )}
          {summary && working?.status === 'REJECTED' && (
            <div className="card reject">
              <h2>v{working.version} no se publicó</h2>
              <ul>
                {(summary.problems ?? []).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              {summary.cases !== undefined && <p className="muted">{evalLine(summary)}</p>}
              {summary.failedCases && summary.failedCases.length > 0 && (
                <details>
                  <summary>Casos fallidos ({summary.failedCases.length})</summary>
                  <ul>
                    {summary.failedCases.map((c) => (
                      <li key={c.id}>
                        <code>{c.id}</code>: {c.failures.join('; ')}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="muted">Corrige el guion y guarda: se crea un borrador nuevo.</p>
            </div>
          )}

          <div className="agent-layout">
            <aside>
              <section className="card">
                <h2>Configuración del agente</h2>
                <div className="form-stack">
                  <label>
                    Idioma
                    <select disabled value="es">
                      <option value="es">Español (Colombia)</option>
                    </select>
                  </label>
                  <label>
                    Nombre del agente *
                    <input
                      value={form.agentName}
                      disabled={readOnly}
                      maxLength={data.limits.agentName}
                      onChange={(e) => set('agentName', e.target.value)}
                    />
                    {fieldError('agentName')}
                  </label>
                  <label>
                    Nombre de empresa *
                    <input
                      value={form.companyName}
                      disabled={readOnly}
                      maxLength={data.limits.companyName}
                      onChange={(e) => set('companyName', e.target.value)}
                    />
                    {fieldError('companyName')}
                  </label>
                  <label>
                    Descripción de la empresa
                    <textarea
                      rows={5}
                      value={form.companyInfo}
                      disabled={readOnly}
                      maxLength={data.limits.companyInfo}
                      onChange={(e) => set('companyInfo', e.target.value)}
                    />
                    {fieldError('companyInfo')}
                  </label>
                  <label>
                    Modelo
                    <select
                      value={form.model ?? ''}
                      disabled={readOnly}
                      onChange={(e) => set('model', e.target.value || null)}
                    >
                      <option value="">
                        Por defecto del servidor ({data.defaultModel ?? data.provider})
                      </option>
                      {data.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    {fieldError('model')}
                  </label>
                  <label>
                    <span className="row-label">
                      Temperatura <b>{form.temperature.toFixed(2)}</b>
                    </span>
                    <input
                      type="range"
                      min={data.limits.temperatureMin}
                      max={data.limits.temperatureMax}
                      step={0.05}
                      value={form.temperature}
                      disabled={readOnly}
                      onChange={(e) => set('temperature', Number(e.target.value))}
                    />
                    <span className="range-ends muted">
                      <span>Más enfocado</span>
                      <span>Más creativo</span>
                    </span>
                    {!data.temperatureApplies && (
                      <span className="muted small">Los modelos Claude no usan temperatura.</span>
                    )}
                    {fieldError('temperature')}
                  </label>
                </div>
              </section>

              <section className="card">
                <h2>Mensaje de bienvenida</h2>
                <p className="muted small">
                  Lo envía el sistema tal cual en el primer mensaje, seguido del menú (fijo).
                </p>
                <textarea
                  rows={4}
                  value={form.welcome}
                  disabled={readOnly}
                  maxLength={data.limits.welcome}
                  onChange={(e) => set('welcome', e.target.value)}
                />
                {fieldError('welcome')}
                <div className="bubble">
                  <Markdown source={`${form.welcome}\n\n${data.menuOptions}`} whatsapp />
                </div>
              </section>

              <section className="card">
                <h2>Catálogo (solo lectura)</h2>
                <p className="muted small">
                  Única fuente de planes y precios. En el guion nómbralos con{' '}
                  <code>{'{{OFERTA:CODIGO}}'}</code> y el sistema inserta la ficha oficial.
                </p>
                {data.catalog.length === 0 && <p className="muted">Sin planes activos.</p>}
                {Object.entries(
                  data.catalog.reduce<Record<string, typeof data.catalog>>((acc, p) => {
                    (acc[p.process] ??= []).push(p);
                    return acc;
                  }, {}),
                ).map(([process, plans]) => (
                  <div key={process} className="plans">
                    <h3>{PROCESS_LABEL[process] ?? process}</h3>
                    {plans.map((p) => (
                      <div key={p.code} className="plan">
                        <div>
                          <code>{p.code}</code> <b>{p.name}</b>
                          <div className="muted small">
                            {p.dataGb} GB · {cop(p.priceCop)}/mes
                            {p.discountText ? ' · con beneficio' : ''}
                          </div>
                        </div>
                        <button className="ghost small" onClick={() => copyMarker(p.code)}>
                          Copiar marcador
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            </aside>

            <section className="card editor-card">
              <div className="editor-bar">
                <div className="segmented">
                  <button
                    className={mode === 'preview' ? '' : 'ghost'}
                    onClick={() => setMode('preview')}
                  >
                    Vista previa
                  </button>
                  <button
                    className={mode === 'markdown' ? '' : 'ghost'}
                    onClick={() => setMode('markdown')}
                  >
                    Markdown
                  </button>
                </div>
                <span className="muted small">
                  ~{tokens.toLocaleString('es-CO')} tokens ·{' '}
                  {form.prompt.length.toLocaleString('es-CO')}/
                  {data.limits.prompt.toLocaleString('es-CO')} caracteres
                </span>
              </div>

              {mode === 'markdown' ? (
                <textarea
                  ref={editor}
                  className="prompt-editor"
                  spellCheck={false}
                  value={form.prompt}
                  disabled={readOnly}
                  maxLength={data.limits.prompt}
                  onChange={(e) => set('prompt', e.target.value)}
                />
              ) : (
                <div className="prompt-preview">
                  <Markdown source={form.prompt} />
                </div>
              )}

              {issuesFor('prompt').length > 0 && (
                <div className="issues">
                  <b>Revisa el guion:</b>
                  <ul>
                    {issuesFor('prompt').map((i, n) => (
                      <li key={n}>
                        {i.line ? (
                          <button className="link" onClick={() => goToLine(i.line!)}>
                            Línea {i.line}
                          </button>
                        ) : (
                          FIELD_LABEL[i.field]
                        )}
                        : {i.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="muted small">
                Organiza las instrucciones por etapa con títulos{' '}
                {data.stages.map((s) => (
                  <code key={s}>## {s}</code>
                ))}
                . El sistema le indica al modelo en qué etapa está; el flujo, el menú, la
                autorización y los textos legales los controla el código.
              </p>

              <button className="link" onClick={() => setShowRules((v) => !v)}>
                {showRules ? 'Ocultar' : 'Ver'} reglas del sistema (no editables, van antes del
                guion)
              </button>
              {showRules && (
                <div className="prompt-preview rules">
                  <Markdown source={data.systemRules} />
                </div>
              )}
            </section>
          </div>

          <section className="card">
            <h2>Historial</h2>
            <table>
              <thead>
                <tr>
                  <th>Versión</th>
                  <th>Estado</th>
                  <th>Agente</th>
                  <th>Modelo</th>
                  <th>Guardó</th>
                  <th>Publicó</th>
                  <th>Evaluación</th>
                  {isAdmin && <th></th>}
                </tr>
              </thead>
              <tbody>
                {versions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted">
                      Sin versiones guardadas: el robot usa la v1 del código.
                    </td>
                  </tr>
                )}
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>v{v.version}</td>
                    <td>
                      <StatusPill status={v.status} />
                    </td>
                    <td>{v.agentName}</td>
                    <td>{v.model ?? 'por defecto'}</td>
                    <td>
                      {v.createdBy} · {time(v.updatedAt)}
                    </td>
                    <td>{v.publishedAt ? `${v.publishedBy} · ${time(v.publishedAt)}` : '—'}</td>
                    <td>{evalLine(v.evalSummary)}</td>
                    {isAdmin && (
                      <td>
                        {v.status !== 'DRAFT' && v.status !== 'EVALUATING' && (
                          <button
                            className="ghost small"
                            disabled={busy || evaluating}
                            onClick={() => void restore(v)}
                          >
                            Restaurar como borrador
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
