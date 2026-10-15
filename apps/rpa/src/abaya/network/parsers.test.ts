import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MESSAGE_URL_PATTERNS, parseCaseResponse, parseSignalRFrame } from './parsers.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../../fixtures/abaya/network/${name}`, import.meta.url), 'utf8'),
  ) as unknown;

describe('parseCaseResponse (ySocial)', () => {
  const r = parseCaseResponse(fixture('ysocial-case.json'));

  it('usa el número del caso como abayaChatId y conserva ids, orden y hora', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.abayaChatId).toBe('9000000001');
    expect(r.value.messages).toHaveLength(6);
    expect(r.value.messages[3]).toMatchObject({
      abayaChatId: '9000000001',
      messageId: '7000000004',
      text: 'Tigo',
      position: 3,
    });
    expect(r.value.messages[3]!.occurredAt.toISOString()).toBe('2026-10-09T13:54:15.000Z');
  });

  it('distingue cliente, asesor (ReplySource 3) y bot yFlow aunque Incoming venga siempre en true', () => {
    if (!r.ok) return;
    expect(r.value.messages.map((m) => m.sender)).toEqual([
      'CUSTOMER', // respuesta de botón del menú
      'SYSTEM', // bot yFlow
      'AGENT',
      'CUSTOMER',
      'AGENT', // imagen enviada por el asesor
      'CUSTOMER', // nota de voz
    ]);
    expect(r.value.messages[2]!.text).toContain('\n');
  });

  it('D-010: la nota de voz del cliente trae el enlace de descarga; la imagen del asesor no es audio', () => {
    if (!r.ok) return;
    expect(r.value.messages[5]!.media).toEqual({
      kind: 'AUDIO',
      url: 'https://abaya.test/blob/7000000006/0/audio.ogg?sig=y&rscd=attachment',
      mimeType: 'audio/ogg',
    });
    expect(r.value.messages[4]!.media).toBeUndefined();
  });

  it('acepta ids de remitente más grandes que un entero seguro (ySocial real, 15/10/2026)', () => {
    const raw = fixture('ysocial-case.json') as {
      Result: { Case: { Messages: { PostedBy?: { ID: unknown } | null }[] } };
    };
    const big = structuredClone(raw);
    for (const m of big.Result.Case.Messages) if (m.PostedBy) m.PostedBy.ID = 2 ** 60;
    const parsed = parseCaseResponse(big);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.messages.map((m) => m.sender)).toEqual(
      r.ok ? r.value.messages.map((m) => m.sender) : [],
    );
  });

  it('rechaza un payload con forma desconocida sin filtrar valores', () => {
    const bad = parseCaseResponse({
      Success: true,
      Result: { Case: { ID: 1, Messages: [{ ID: 2, Body: '3001234567' }] } },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).not.toContain('3001234567');
    expect(parseCaseResponse({ Success: false, Result: null }).ok).toBe(false);
  });
});

describe('parseSignalRFrame', () => {
  const frames = fixture('ysocial-signalr-frames.json') as string[];

  it('ignora saludo, pings y métodos que el robot no usa', () => {
    for (const i of [0, 1, 2, 5]) {
      const p = parseSignalRFrame(frames[i]!);
      expect(p).toEqual({ ok: true, value: [] });
    }
  });

  it('mensaje nuevo en un caso asignado → actividad del caso (solo ids)', () => {
    expect(parseSignalRFrame(frames[3]!)).toEqual({
      ok: true,
      value: [{ kind: 'caseActivity', abayaChatId: '9000000001', messageId: '7000000004' }],
    });
  });

  it('lee varios mensajes de un mismo frame y el estado de entrega más avanzado', () => {
    const p = parseSignalRFrame(frames[4]!);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value).toEqual([
      { kind: 'messageStatus', messageId: '7000000003', status: 'SENT' },
      { kind: 'messageStatus', messageId: '7000000003', status: 'READ' },
    ]);
  });

  it('un evento conocido con forma inválida es error; texto suelto también', () => {
    const bad = JSON.stringify({
      type: 1,
      target: 'receive',
      arguments: [{ method: 'NewMessageFromAssignedCase', moreInfo: { caseId: 'abc' } }],
    });
    expect(parseSignalRFrame(`${bad}\u001e`).ok).toBe(false);
    expect(parseSignalRFrame('ping').ok).toBe(false);
  });
});

describe('MESSAGE_URL_PATTERNS', () => {
  it('reconoce el caso completo y el tiempo real de ySocial', () => {
    expect(
      MESSAGE_URL_PATTERNS.caseMessages.test(
        'https://claro-co.ysocial.net/services/messaging/case?id=1&socialUserProfileId=2',
      ),
    ).toBe(true);
    expect(
      MESSAGE_URL_PATTERNS.caseMessages.test(
        'https://claro-co.ysocial.net/services/messaging/searchcases?socialUserProfileId=2',
      ),
    ).toBe(false);
    expect(
      MESSAGE_URL_PATTERNS.websocket.test('wss://ysocial.service.signalr.net/client/?hub=x'),
    ).toBe(true);
  });
});
