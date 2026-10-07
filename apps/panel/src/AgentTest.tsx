import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  type AgentFields,
  type AgentIssue,
  type AgentTestResult,
  type AgentTestState,
} from './api.js';
import { message as errorMessage, ms } from './format.js';
import { Markdown } from './Markdown.js';

/**
 * "Probar agente" (v1.8), como en Dapta/Retell: un chat de simulación contra el motor real
 * (máquina de estados, catálogo, plantillas y validadores). No toca Abaya ni guarda nada.
 */

type Entry =
  | { kind: 'customer'; text: string }
  | { kind: 'bot'; text: string; meta?: string }
  | { kind: 'event'; text: string };

const EMPTY: AgentTestState = { stage: 'MENU', profile: {}, history: [] };

const VALIDATION_LABEL: Record<string, string> = {
  OK: 'modelo · validado',
  REGENERATED: 'modelo · regenerado 1 vez',
  FALLBACK: 'respuesta segura (el modelo no pasó los validadores)',
  NO_LLM: 'plantilla del sistema',
  PROVIDER_ERROR: 'proveedor de LLM con error',
};

const TERMINAL = new Set(['TRANSFERENCIA', 'SOPORTE', 'CIERRE_SIN_VENTA', 'ESCALAR']);

const PROFILE_LABEL: Record<string, string> = {
  process: 'Proceso',
  name: 'Nombre',
  currentOperator: 'Operador actual',
  usage: 'Uso',
  offeredPlanCode: 'Plan ofrecido',
  planCode: 'Plan aceptado',
};

export function AgentTest({
  isAdmin,
  fields,
  provider,
  onIssues,
  onExpired,
}: {
  isAdmin: boolean;
  fields: AgentFields;
  provider: string;
  onIssues: (issues: AgentIssue[]) => void;
  onExpired: () => void;
}) {
  const [source, setSource] = useState<'editor' | 'published'>(isAdmin ? 'editor' : 'published');
  const [state, setState] = useState<AgentTestState>(EMPTY);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [entries, busy]);

  // Tras cada respuesta, el cursor vuelve al campo para seguir escribiendo.
  useEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy]);

  const reset = () => {
    setState(EMPTY);
    setEntries([]);
    setError(null);
  };

  const ended = TERMINAL.has(state.stage);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const msg = text.trim();
    if (!msg || busy || ended) return;
    setText('');
    setError(null);
    setEntries((x) => [...x, { kind: 'customer', text: msg }]);
    setBusy(true);
    try {
      const r: AgentTestResult = await api.testAgent({
        source,
        ...(source === 'editor' ? { fields } : {}),
        state,
        message: msg,
      });
      const call = r.llm.at(-1);
      const meta =
        (VALIDATION_LABEL[r.validation] ?? r.validation) +
        (call ? ` · ${call.model} · ${ms(r.llm.reduce((a, c) => a + c.latencyMs, 0))}` : '');
      setEntries((x) => [
        ...x,
        ...r.replies.map((t, i) => ({
          kind: 'bot' as const,
          text: t,
          ...(i === r.replies.length - 1 ? { meta } : {}),
        })),
        ...r.events.map((t) => ({ kind: 'event' as const, text: t })),
      ]);
      setState({
        stage: r.stage,
        profile: r.profile,
        history: [
          ...state.history,
          { role: 'customer' as const, text: msg },
          ...r.replies.map((t) => ({ role: 'bot' as const, text: t })),
        ].slice(-40),
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onExpired();
      if (err instanceof ApiError && err.issues) {
        onIssues(err.issues);
        setError(
          'El borrador tiene problemas de revisión: corrígelos en la pestaña Configuración.',
        );
      } else {
        setError(errorMessage(err, 'No se pudo correr la prueba.'));
      }
      setEntries((x) => x.slice(0, -1));
      setText(msg);
    } finally {
      setBusy(false);
    }
  };

  const profileRows = Object.entries(state.profile).filter(([k]) => PROFILE_LABEL[k]);

  return (
    <div className="test-layout">
      <section className="card chat-card">
        <div className="editor-bar">
          <div className="segmented">
            {isAdmin && (
              <button
                className={source === 'editor' ? '' : 'ghost'}
                onClick={() => {
                  setSource('editor');
                  reset();
                }}
              >
                Lo que hay en el editor
              </button>
            )}
            <button
              className={source === 'published' ? '' : 'ghost'}
              onClick={() => {
                setSource('published');
                reset();
              }}
            >
              Versión publicada
            </button>
          </div>
          <button className="ghost small" onClick={reset} disabled={busy}>
            Reiniciar conversación
          </button>
        </div>

        <div className="chat">
          {entries.length === 0 && (
            <p className="muted chat-empty">
              Escribe como si fueras el cliente (por ejemplo "Hola"). El primer mensaje recibe la
              bienvenida y el menú.
            </p>
          )}
          {entries.map((m, i) =>
            m.kind === 'event' ? (
              <div key={i} className="chat-event">
                {m.text}
              </div>
            ) : (
              <div key={i} className={`chat-msg ${m.kind}`}>
                <div className="chat-bubble">
                  {m.kind === 'bot' ? <Markdown source={m.text} whatsapp /> : m.text}
                </div>
                {m.kind === 'bot' && m.meta && <div className="chat-meta">{m.meta}</div>}
              </div>
            ),
          )}
          {busy && <div className="chat-msg bot typing">escribiendo…</div>}
          <div ref={bottom} />
        </div>

        {error && <p className="notice bad-notice">{error}</p>}
        {ended && (
          <p className="notice">
            La conversación terminó en <b>{state.stage}</b>. Reinicia para probar otra.
          </p>
        )}
        <form className="chat-input" onSubmit={(e) => void send(e)}>
          <input
            value={text}
            placeholder={ended ? 'Conversación terminada' : 'Mensaje del cliente…'}
            ref={input}
            disabled={ended}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={busy || ended || !text.trim()}>
            Enviar
          </button>
        </form>
      </section>

      <aside className="card">
        <h2>Estado de la simulación</h2>
        <dl className="facts">
          <dt>Etapa</dt>
          <dd>
            <code>{state.stage}</code>
          </dd>
          {profileRows.map(([k, v]) => (
            <FactRow key={k} label={PROFILE_LABEL[k]!} value={v} />
          ))}
          <dt>Proveedor</dt>
          <dd>{provider}</dd>
        </dl>
        <p className="muted small">
          Usa el motor real: la máquina de estados decide el flujo, los precios salen del catálogo y
          cada respuesta del modelo pasa por los validadores. No se envía nada a Abaya ni se guarda
          la conversación.
        </p>
        {provider === 'simulado' && (
          <p className="notice small">
            Con el proveedor <b>simulado</b> responde un cerebro heurístico que no lee el guion:
            sirve para probar el flujo, no la redacción. Para probar el guion configura un proveedor
            real con su API key.
          </p>
        )}
      </aside>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
