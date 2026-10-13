import type { InboundMessage, SenderType } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import type { Page, Response, WebSocket } from 'playwright';
import {
  MESSAGE_URL_PATTERNS,
  parseCaseResponse,
  parseSignalRFrame,
} from '../abaya/network/parsers.js';
import { sel } from '../abaya/selectors.js';
import { z } from 'zod';
import type { InboundProcessor } from './inbound-processor.js';

/**
 * La función expuesta a la página la puede invocar cualquier script de Abaya: lo que llega
 * se valida como cualquier entrada externa (F8).
 */
const domRowsSchema = z
  .array(
    z.object({
      chatId: z.string().max(40).nullable(),
      id: z.string().max(40).nullable(),
      sender: z.string().max(40).nullable(),
      text: z.string().max(10_000),
    }),
  )
  .max(2_000);

const DOM_BINDING = '__abayaInboundDom';

/**
 * Sección 6.2: escucha la red (el caso completo y el tiempo real de ySocial) y, de respaldo, el
 * DOM con un MutationObserver. NUNCA hace clics ni escribe (regla 4): solo lee.
 */
export class InboundWatcher {
  /** Respuestas o frames que no cumplieron el esquema (posible cambio de interfaz). */
  parseFailures = 0;
  private readonly attached = new WeakSet<Page>();

  constructor(
    private readonly processor: InboundProcessor,
    private readonly logger: Logger,
  ) {}

  async attach(page: Page): Promise<void> {
    if (this.attached.has(page)) return;
    this.attached.add(page);

    page.on('response', (r) => void this.onResponse(r));
    page.on('websocket', (ws) => this.onWebSocket(ws));

    await page.exposeFunction(DOM_BINDING, (rows: unknown) => this.onDomRows(rows));
    await page.addInitScript(installDomObserver, {
      binding: DOM_BINDING,
      messageItem: sel.dom.messageItem,
      idPrefix: sel.dom.messageIdPrefix,
      body: sel.dom.body,
      caseHeader: sel.dom.caseHeader,
      headerCaseId: sel.dom.headerCaseId,
      senders: sel.dom.senders,
    });
  }

  private async onResponse(r: Response) {
    if (!MESSAGE_URL_PATTERNS.caseMessages.test(r.url())) return;
    if (!r.ok() || r.request().method() !== 'GET') return;
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      return; // página cerrada o cuerpo no JSON
    }
    const parsed = parseCaseResponse(body);
    if (!parsed.ok) return this.parseFailed('xhr', parsed.error);
    // La consola pide el caso al recibirlo y con cada mensaje nuevo: también es la señal de
    // caso asignado (crea la Conversation la primera vez).
    await this.processor.chatAssigned(parsed.value.abayaChatId);
    for (const msg of parsed.value.messages) void this.processor.handle(msg, 'network');
  }

  /**
   * SignalR solo trae ids («llegó un mensaje al caso N»): el contenido llega cuando la consola
   * pide el caso completo. Aquí solo se valida la forma, para detectar cambios de interfaz.
   */
  private onWebSocket(ws: WebSocket) {
    if (!MESSAGE_URL_PATTERNS.websocket.test(ws.url())) return;
    ws.on('framereceived', ({ payload }) => {
      const parsed = parseSignalRFrame(payload);
      if (!parsed.ok) this.parseFailed('ws', parsed.error);
    });
  }

  /**
   * Respaldo por DOM: solo el caso abierto (el encabezado «Caso #N» da el id). La pantalla no
   * trae la hora exacta: se usa la de detección; la huella usa el id del mensaje.
   */
  private onDomRows(raw: unknown) {
    const parsed = domRowsSchema.safeParse(raw);
    if (!parsed.success) return this.parseFailed('dom', 'filas del DOM con forma inválida');
    const now = new Date();
    for (const row of parsed.data) {
      if (!row.chatId || !row.id) continue;
      const sender = (sel.dom.senders as Record<string, SenderType>)[row.sender ?? ''];
      if (!sender) continue;
      const msg: InboundMessage = {
        abayaChatId: row.chatId,
        messageId: row.id,
        sender,
        text: row.text.trim(),
        occurredAt: now,
      };
      void this.processor.handle(msg, 'dom');
    }
  }

  private parseFailed(source: 'xhr' | 'ws' | 'dom', error: string) {
    this.parseFailures++;
    this.logger.warn({ source, error }, 'payload de Abaya no reconocido');
  }
}

/** Corre DENTRO de la página. No debe referenciar nada externo. */
function installDomObserver(cfg: {
  binding: string;
  messageItem: string;
  idPrefix: string;
  body: string;
  caseHeader: string;
  headerCaseId: string;
  senders: Record<string, string>;
}) {
  const w = window as unknown as Record<string, (rows: unknown[]) => void>;
  const caseId = () => {
    const h = document.querySelector(cfg.caseHeader) as HTMLElement | null;
    return h ? (new RegExp(cfg.headerCaseId).exec(h.innerText)?.[1] ?? null) : null;
  };
  const collect = (roots: Node[]) => {
    const rows: unknown[] = [];
    const chatId = caseId();
    for (const root of roots) {
      if (!(root instanceof Element)) continue;
      const msgs = root.matches(cfg.messageItem)
        ? [root]
        : Array.from(root.querySelectorAll(cfg.messageItem));
      for (const el of msgs) {
        const cls = Object.keys(cfg.senders).find((c) => el.classList.contains(c)) ?? null;
        rows.push({
          chatId,
          id: el.id.startsWith(cfg.idPrefix) ? el.id.slice(cfg.idPrefix.length) : null,
          sender: cls,
          text: (el.querySelector(cfg.body) as HTMLElement | null)?.innerText ?? '',
        });
      }
    }
    if (rows.length && typeof w[cfg.binding] === 'function') w[cfg.binding]!(rows);
  };
  const start = () => {
    collect([document.body]);
    new MutationObserver((muts) => collect(muts.flatMap((m) => Array.from(m.addedNodes)))).observe(
      document.body,
      { childList: true, subtree: true },
    );
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
