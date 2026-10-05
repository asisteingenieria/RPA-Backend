import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MESSAGE_URL_PATTERNS, parseChatMessagesResponse, parseWsFrame } from './parsers.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../../fixtures/abaya/network/${name}`, import.meta.url), 'utf8'),
  ) as unknown;

describe('parseChatMessagesResponse', () => {
  it('normaliza la respuesta de mensajes del fixture', () => {
    const r = parseChatMessagesResponse(fixture('mock-chat-messages.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(3);
    expect(r.value.map((m) => m.sender)).toEqual(['SYSTEM', 'CUSTOMER', 'AGENT']);
    expect(r.value[1]).toMatchObject({ abayaChatId: 'CH-1001', messageId: 'm-2', position: 1 });
    expect(r.value[1]!.occurredAt.toISOString()).toBe('2026-10-05T14:00:05.000Z');
  });

  it('rechaza un payload con forma desconocida sin filtrar valores', () => {
    const r = parseChatMessagesResponse({
      chatId: 'CH-1',
      messages: [{ id: 'x', texto: '3001234567' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toContain('3001234567');
  });

  it('rechaza un remitente desconocido', () => {
    const r = parseChatMessagesResponse({
      chatId: 'CH-1',
      messages: [
        { id: 'x', sender: { type: 'bot' }, text: 'hola', sentAt: '2026-10-05T14:00:00Z' },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

describe('parseWsFrame', () => {
  const frames = fixture('mock-ws-frames.json') as unknown[];

  it('reconoce mensaje nuevo, chat asignado y chat retirado', () => {
    const parsed = frames.map((f) => parseWsFrame(JSON.stringify(f)));
    expect(parsed.every((p) => p.ok)).toBe(true);
    const kinds = parsed.map((p) => (p.ok ? p.value.kind : null));
    expect(kinds).toEqual(['message', 'chatAssigned', 'chatRemoved']);
    const first = parsed[0]!;
    if (first.ok && first.value.kind === 'message') {
      expect(first.value.message).toMatchObject({ abayaChatId: 'CH-1001', sender: 'CUSTOMER' });
      expect(first.value.message.occurredAt.toISOString()).toBe('2026-10-05T19:01:00.000Z');
    }
  });

  it('descarta frames que no son JSON o con evento desconocido', () => {
    expect(parseWsFrame('ping').ok).toBe(false);
    expect(parseWsFrame(JSON.stringify({ event: 'typing', data: {} })).ok).toBe(false);
  });
});

describe('MESSAGE_URL_PATTERNS', () => {
  it('extrae el id del chat de la URL de mensajes', () => {
    const m = MESSAGE_URL_PATTERNS.chatMessages.exec(
      'https://abaya.test/api/chats/CH-9/messages?since=1',
    );
    expect(m?.[1]).toBe('CH-9');
    expect(MESSAGE_URL_PATTERNS.chatMessages.test('https://abaya.test/api/chats/CH-9/notes')).toBe(
      false,
    );
  });
});
