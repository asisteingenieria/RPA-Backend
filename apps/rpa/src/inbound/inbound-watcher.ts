import type { InboundMessage, SenderType } from '@abaya/domain';
import type { Logger } from '@abaya/logger';
import type { Page, Response, WebSocket } from 'playwright';
import {
  MESSAGE_URL_PATTERNS,
  parseChatMessagesResponse,
  parseWsFrame,
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
      kind: z.enum(['message', 'chat']),
      chatId: z.string().max(200).nullable(),
      id: z.string().max(200).nullable().optional(),
      sender: z.string().max(40).nullable().optional(),
      ts: z.string().max(60).nullable().optional(),
      text: z.string().max(10_000).optional(),
    }),
  )
  .max(2_000);

const DOM_BINDING = '__abayaInboundDom';

interface DomRow {
  kind: 'message' | 'chat';
  chatId: string | null;
  id?: string | null;
  sender?: string | null;
  ts?: string | null;
  text?: string;
}

/**
 * Sección 6.2: escucha la red (XHR + WebSocket) y, de respaldo, el DOM con un
 * MutationObserver. NUNCA hace clics ni escribe (regla 4): solo lee.
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
      chatContainer: sel.dom.chatContainer,
      chatListItem: sel.dom.chatListItem,
      attrs: sel.dom.attrs,
    });
  }

  private async onResponse(r: Response) {
    const m = MESSAGE_URL_PATTERNS.chatMessages.exec(r.url());
    if (!m || !r.ok() || r.request().method() !== 'GET') return;
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      return; // página cerrada o cuerpo no JSON
    }
    const parsed = parseChatMessagesResponse(body);
    if (!parsed.ok) return this.parseFailed('xhr', parsed.error);
    for (const msg of parsed.value) void this.processor.handle(msg, 'network');
  }

  private onWebSocket(ws: WebSocket) {
    if (!MESSAGE_URL_PATTERNS.websocket.test(ws.url())) return;
    ws.on('framereceived', ({ payload }) => {
      const parsed = parseWsFrame(payload);
      if (!parsed.ok) return this.parseFailed('ws', parsed.error);
      const ev = parsed.value;
      if (ev.kind === 'message') void this.processor.handle(ev.message, 'network');
      else if (ev.kind === 'chatAssigned') void this.processor.chatAssigned(ev.abayaChatId);
    });
  }

  private onDomRows(raw: unknown) {
    const parsed = domRowsSchema.safeParse(raw);
    if (!parsed.success) return this.parseFailed('dom', 'filas del DOM con forma inválida');
    const rows: DomRow[] = parsed.data;
    for (const row of rows) {
      if (!row.chatId) continue;
      if (row.kind === 'chat') {
        void this.processor.chatAssigned(row.chatId);
        continue;
      }
      const sender = (sel.dom.senders as Record<string, SenderType>)[row.sender ?? ''];
      if (!sender || !row.ts || Number.isNaN(Date.parse(row.ts))) continue;
      const msg: InboundMessage = {
        abayaChatId: row.chatId,
        ...(row.id ? { messageId: row.id } : {}),
        sender,
        text: (row.text ?? '').trim(),
        occurredAt: new Date(row.ts),
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
  chatContainer: string;
  chatListItem: string;
  attrs: { messageId: string; chatId: string; sender: string; timestamp: string };
}) {
  const w = window as unknown as Record<string, (rows: unknown[]) => void>;
  const collect = (roots: Node[]) => {
    const rows: unknown[] = [];
    for (const root of roots) {
      if (!(root instanceof Element)) continue;
      const msgs = root.matches(cfg.messageItem)
        ? [root]
        : Array.from(root.querySelectorAll(cfg.messageItem));
      for (const el of msgs) {
        const chat = el.closest(cfg.chatContainer);
        rows.push({
          kind: 'message',
          chatId: chat?.getAttribute(cfg.attrs.chatId) ?? null,
          id: el.getAttribute(cfg.attrs.messageId),
          sender: el.getAttribute(cfg.attrs.sender),
          ts: el.getAttribute(cfg.attrs.timestamp),
          text: (el as HTMLElement).innerText,
        });
      }
      const chats = root.matches(cfg.chatListItem)
        ? [root]
        : Array.from(root.querySelectorAll(cfg.chatListItem));
      for (const el of chats) {
        rows.push({ kind: 'chat', chatId: el.getAttribute(cfg.attrs.chatId) });
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
